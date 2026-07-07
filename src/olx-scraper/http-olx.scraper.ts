import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosProxyConfig } from 'axios';
import * as cheerio from 'cheerio';
import { AppConfig } from '../config/configuration';
import { OlxListing, OlxScraper, SearchCriteria } from './olx-scraper.interface';
import { sleep, withRetry } from './retry.util';

/**
 * Real OLX.ua scraper.
 *
 * ⚠️ Best-effort by design. OLX has no public API for this use case and its
 * markup/params change over time, so treat the URL builder and parsers below
 * as a *starting point to iterate on against the live site*, not a guarantee.
 * Everything is wrapped so that any failure yields `[]` (never a throw) — a bad
 * fetch must not break the polling loop. `SCRAPER=mock` remains the safe default
 * for demoing the full pipeline without network.
 *
 * Two parse strategies are tried in order:
 *   1. the embedded Next.js `__NEXT_DATA__` JSON (richest: area + owner/business)
 *   2. server-rendered HTML cards (`[data-cy="l-card"]`) as a fallback
 */
@Injectable()
export class HttpOlxScraper implements OlxScraper {
  private readonly logger = new Logger(HttpOlxScraper.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly categoryPath: string;
  private readonly maxRetries: number;

  // A small pool of realistic desktop UAs, rotated per request.
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ];

  constructor(config: ConfigService<AppConfig, true>) {
    const cfg = config.get('scraper', { infer: true });
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.categoryPath = cfg.categoryPath.replace(/^\/+|\/+$/g, '');
    this.maxRetries = cfg.maxRetries;

    this.http = axios.create({
      timeout: cfg.timeoutMs,
      // Handle redirects ourselves-friendly; accept gzip.
      maxRedirects: 5,
      proxy: this.parseProxy(cfg.proxyUrl),
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
      },
      // We check status ourselves so a 4xx/5xx becomes a retryable throw.
      validateStatus: () => true,
    });
  }

  async fetchListings(criteria: SearchCriteria): Promise<OlxListing[]> {
    const url = this.buildUrl(criteria);
    try {
      const html = await withRetry(() => this.fetchHtml(url), {
        retries: this.maxRetries,
        baseDelayMs: 800,
        maxDelayMs: 8000,
        onRetry: (attempt, err, waitMs) =>
          this.logger.warn(
            `Fetch attempt ${attempt} failed (${(err as Error).message}); retrying in ${waitMs}ms`,
          ),
      });

      let listings = this.parseNextData(html);
      if (listings.length === 0) {
        listings = this.parseHtmlCards(html);
      }

      this.logger.debug(`[http] ${listings.length} listing(s) from ${url}`);
      // Apply the filters we couldn't be sure the URL enforced.
      return listings.filter((l) => this.matches(l, criteria));
    } catch (err) {
      this.logger.error(`[http] giving up on ${url}: ${(err as Error).message}`);
      return []; // never throw into the polling loop
    }
  }

  // --- HTTP ---------------------------------------------------------------

  private async fetchHtml(url: string): Promise<string> {
    // Tiny politeness delay + UA rotation to look less robotic.
    await sleep(Math.floor(Math.random() * 400));
    const res = await this.http.get<string>(url, {
      responseType: 'text',
      headers: { 'User-Agent': this.pickUserAgent() },
    });
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.data;
  }

  private pickUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private parseProxy(proxyUrl?: string): AxiosProxyConfig | false {
    if (!proxyUrl) return false;
    try {
      const u = new URL(proxyUrl);
      const proxy: AxiosProxyConfig = {
        host: u.hostname,
        port: Number.parseInt(u.port || '80', 10),
        protocol: u.protocol.replace(':', ''),
      };
      if (u.username || u.password) {
        proxy.auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
      }
      return proxy;
    } catch {
      this.logger.error(`Invalid HTTP_PROXY_URL, ignoring proxy.`);
      return false;
    }
  }

  // --- URL building -------------------------------------------------------

  private buildUrl(c: SearchCriteria): string {
    const params = new URLSearchParams();
    // City + district as full-text search. Mapping a free-text city to OLX's
    // location-slug path is brittle, so we lean on `q` here — refine to proper
    // location filters once tuned against the live site.
    const q = [c.city, c.district].filter(Boolean).join(' ').trim();
    if (q) params.set('q', q);

    if (c.priceMin != null) params.set('search[filter_float_price:from]', String(c.priceMin));
    if (c.priceMax != null) params.set('search[filter_float_price:to]', String(c.priceMax));
    if (c.areaMin != null) params.set('search[filter_float_total_area:from]', String(c.areaMin));
    if (c.areaMax != null) params.set('search[filter_float_total_area:to]', String(c.areaMax));
    if (c.ownerOnly) params.set('search[private_business]', 'private');

    // Newest first.
    params.set('search[order]', 'created_at:desc');

    return `${this.baseUrl}/${this.categoryPath}/?${params.toString()}`;
  }

  // --- Parsing: __NEXT_DATA__ --------------------------------------------

  private parseNextData(html: string): OlxListing[] {
    try {
      const $ = cheerio.load(html);
      const json = $('#__NEXT_DATA__').first().html();
      if (!json) return [];
      const data = JSON.parse(json);

      const found: OlxListing[] = [];
      const seen = new Set<string>();
      this.collectListingObjects(data, (obj) => {
        const listing = this.mapObjectToListing(obj);
        if (listing && !seen.has(listing.id)) {
          seen.add(listing.id);
          found.push(listing);
        }
      });
      return found;
    } catch (err) {
      this.logger.warn(`__NEXT_DATA__ parse failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Walk the JSON tree collecting objects that look like OLX offers. */
  private collectListingObjects(node: any, visit: (obj: any) => void, depth = 0): void {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) this.collectListingObjects(item, visit, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      const looksLikeOffer =
        (typeof node.id === 'number' || typeof node.id === 'string') &&
        typeof node.title === 'string' &&
        typeof node.url === 'string';
      if (looksLikeOffer) visit(node);
      for (const key of Object.keys(node)) {
        this.collectListingObjects(node[key], visit, depth + 1);
      }
    }
  }

  private mapObjectToListing(obj: any): OlxListing | null {
    try {
      const id = String(obj.id);
      const title = String(obj.title).trim();
      let url = String(obj.url);
      if (url.startsWith('/')) url = `${this.baseUrl}${url}`;

      return {
        id,
        title,
        price: this.extractPrice(obj),
        currency: this.extractCurrency(obj) ?? 'грн',
        area: this.extractArea(obj),
        city: this.extractLocation(obj, 'city'),
        district: this.extractLocation(obj, 'district'),
        url,
        imageUrl: this.extractPhoto(obj),
        isBusiness: this.extractBusiness(obj),
      };
    } catch {
      return null;
    }
  }

  private extractPrice(obj: any): number | null {
    // Try common OLX shapes, then a "price" param.
    const candidates = [
      obj?.price?.regularPrice?.value,
      obj?.price?.value,
      obj?.price?.regularPrice?.amount,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    const param = this.findParam(obj, ['price']);
    const fromParam = Number(param?.value?.value ?? param?.value);
    return Number.isFinite(fromParam) && fromParam > 0 ? Math.round(fromParam) : null;
  }

  private extractCurrency(obj: any): string | undefined {
    return obj?.price?.regularPrice?.currencyCode ?? obj?.price?.currency ?? undefined;
  }

  private extractArea(obj: any): number | null {
    const param = this.findParam(obj, ['total_area', 'area', 'm']);
    const raw = param?.value?.key ?? param?.value?.value ?? param?.value;
    const n = Number.parseFloat(String(raw ?? '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }

  private extractLocation(obj: any, which: 'city' | 'district'): string | undefined {
    const loc = obj?.location ?? obj?.map ?? {};
    if (which === 'city') return loc?.city?.name ?? loc?.cityName ?? undefined;
    return loc?.district?.name ?? loc?.districtName ?? undefined;
  }

  private extractPhoto(obj: any): string | undefined {
    const photos = obj?.photos;
    if (Array.isArray(photos) && photos.length > 0) {
      const first = photos[0];
      const link: string | undefined = first?.link ?? first?.url ?? first;
      if (typeof link === 'string') {
        // OLX photo links often contain "{width}x{height}" placeholders.
        return link.replace('{width}', '640').replace('{height}', '480');
      }
    }
    return undefined;
  }

  private extractBusiness(obj: any): boolean {
    return Boolean(obj?.business ?? obj?.isBusiness ?? obj?.user?.isBusiness ?? false);
  }

  private findParam(obj: any, keys: string[]): any {
    const params = obj?.params;
    if (!Array.isArray(params)) return undefined;
    return params.find((p: any) => keys.some((k) => String(p?.key ?? '').includes(k)));
  }

  // --- Parsing: HTML cards (fallback) ------------------------------------

  private parseHtmlCards(html: string): OlxListing[] {
    try {
      const $ = cheerio.load(html);
      const cards = $('[data-cy="l-card"]');
      const listings: OlxListing[] = [];

      cards.each((_, el) => {
        const card = $(el);
        const id = card.attr('id') || card.find('a[href]').attr('href') || '';
        if (!id) return;

        const title = card.find('[data-cy="ad-card-title"], h6, h4').first().text().trim();
        const href = card.find('a[href]').first().attr('href') || '';
        const url = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
        const priceText = card.find('[data-testid="ad-price"]').first().text();
        const img = card.find('img').first().attr('src') || undefined;
        const locationText = card.find('[data-testid="location-date"]').first().text();

        if (!title || !url) return;

        listings.push({
          id: String(id),
          title,
          price: this.parsePriceText(priceText),
          currency: 'грн',
          area: null,
          city: locationText?.split('-')[0]?.trim() || undefined,
          district: undefined,
          url,
          imageUrl: img,
          // Not reliably available in the card markup — assume private and let
          // the (stricter) __NEXT_DATA__ path override when present.
          isBusiness: false,
        });
      });

      return listings;
    } catch (err) {
      this.logger.warn(`HTML card parse failed: ${(err as Error).message}`);
      return [];
    }
  }

  private parsePriceText(text: string): number | null {
    const digits = (text || '').replace(/[^\d]/g, '');
    if (!digits) return null;
    const n = Number.parseInt(digits, 10);
    return Number.isFinite(n) ? n : null;
  }

  private matches(l: OlxListing, c: SearchCriteria): boolean {
    if (c.ownerOnly && l.isBusiness) return false;
    if (l.price !== null) {
      if (c.priceMin != null && l.price < c.priceMin) return false;
      if (c.priceMax != null && l.price > c.priceMax) return false;
    }
    if (l.area !== null) {
      if (c.areaMin != null && l.area < c.areaMin) return false;
      if (c.areaMax != null && l.area > c.areaMax) return false;
    }
    return true;
  }
}
