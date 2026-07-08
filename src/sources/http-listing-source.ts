import { Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosProxyConfig } from 'axios';
import { SourcesConfig } from '../config/configuration';
import { Listing, RawListing, SearchCriteria } from './listing.interface';
import { ListingSource } from './listing-source.interface';
import { sleep, withRetry } from './retry.util';

/** Helpers a site spec can use to fetch (retry/proxy/UA handled for it). */
export interface SiteContext {
  cfg: SourcesConfig;
  getHtml(url: string): Promise<string>;
  getJson<T = any>(url: string): Promise<T>;
}

/**
 * One site's adapter — either declarative (buildUrl + parse) or, for multi-step
 * APIs (e.g. DOM.RIA: search ids → info per id), an imperative `fetch`.
 */
export interface SiteSpec {
  id: string;
  label: string;
  /** Imperative path for multi-step / API sources. Takes precedence. */
  fetch?(ctx: SiteContext, criteria: SearchCriteria): Promise<RawListing[]>;
  /** Declarative path: build a URL, fetch it, parse the payload. */
  kind?: 'html' | 'json';
  buildUrl?(criteria: SearchCriteria, cfg: SourcesConfig): string | null;
  parse?(payload: any, cfg: SourcesConfig): RawListing[];
}

/**
 * Runs a `SiteSpec` — does the real HTTP fetch, stamps each listing with
 * `source`/`sourceLabel`, and never throws (returns [] on any failure).
 */
export class HttpListingSource implements ListingSource {
  readonly id: string;
  readonly label: string;
  private readonly logger: Logger;
  private readonly http: AxiosInstance;
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  ];

  constructor(
    private readonly spec: SiteSpec,
    private readonly cfg: SourcesConfig,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.logger = new Logger(`Source:${spec.id}`);
    this.http = axios.create({
      timeout: cfg.timeoutMs,
      maxRedirects: 5,
      proxy: this.parseProxy(cfg.proxyUrl),
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7',
      },
      validateStatus: () => true,
    });
  }

  async fetchListings(criteria: SearchCriteria): Promise<Listing[]> {
    const raw = await this.fetchReal(criteria);
    return raw.map((l) => ({ ...l, source: this.id, sourceLabel: this.label }));
  }

  // --- real fetch ---------------------------------------------------------

  private async fetchReal(criteria: SearchCriteria): Promise<RawListing[]> {
    try {
      const ctx: SiteContext = {
        cfg: this.cfg,
        getHtml: (url) => this.getHtml(url),
        getJson: (url) => this.getJson(url),
      };
      if (this.spec.fetch) {
        return await this.spec.fetch(ctx, criteria);
      }
      const url = this.spec.buildUrl?.(criteria, this.cfg) ?? null;
      if (!url) return [];
      const payload = this.spec.kind === 'json' ? await this.getJson(url) : await this.getHtml(url);
      const parsed = this.spec.parse?.(payload, this.cfg) ?? [];
      this.logger.debug(`[http] ${parsed.length} listing(s) from ${url}`);
      return parsed;
    } catch (err) {
      this.logger.error(`[http] ${this.id} failed: ${(err as Error).message}`);
      return [];
    }
  }

  private async getHtml(url: string): Promise<string> {
    return withRetry(
      async () => {
        await sleep(Math.floor(Math.random() * 400));
        const res = await this.http.get<string>(url, {
          responseType: 'text',
          headers: { 'User-Agent': this.pickUserAgent() },
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res.data;
      },
      { retries: this.cfg.maxRetries, baseDelayMs: 800, maxDelayMs: 8000 },
    );
  }

  private async getJson<T>(url: string): Promise<T> {
    return withRetry(
      async () => {
        await sleep(Math.floor(Math.random() * 300));
        const res = await this.http.get<T>(url, {
          responseType: 'json',
          headers: { 'User-Agent': this.pickUserAgent(), Accept: 'application/json' },
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return res.data;
      },
      { retries: this.cfg.maxRetries, baseDelayMs: 800, maxDelayMs: 8000 },
    );
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
        proxy.auth = {
          username: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
        };
      }
      return proxy;
    } catch {
      return false;
    }
  }
}
