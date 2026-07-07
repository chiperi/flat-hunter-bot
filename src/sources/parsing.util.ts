import * as cheerio from 'cheerio';
import { RawListing } from './listing.interface';

/**
 * Shared, defensive parsing helpers for the site specs. Everything here is
 * best-effort and returns empty/undefined rather than throwing — real markup
 * drifts, so specs lean on these and are expected to be tuned against the live
 * sites over time.
 */

export function toInt(value: unknown): number | null {
  const n = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function toFloat(value: unknown): number | null {
  const n = Number.parseFloat(String(value ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function absoluteUrl(href: string | undefined, baseUrl: string): string {
  if (!href) return baseUrl;
  if (href.startsWith('http')) return href;
  return `${baseUrl.replace(/\/+$/, '')}/${href.replace(/^\/+/, '')}`;
}

/** Pull and JSON-parse the Next.js `__NEXT_DATA__` blob, if present. */
export function extractNextData(html: string): unknown | null {
  try {
    const $ = cheerio.load(html);
    const json = $('#__NEXT_DATA__').first().html();
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/**
 * Walk an arbitrary JSON tree collecting objects that look like listing offers
 * (have an id + a title + a url). Bounded depth so a huge blob can't hang us.
 */
export function deepFindOffers(node: unknown, depth = 0, out: any[] = []): any[] {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const item of node) deepFindOffers(item, depth + 1, out);
    return out;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, any>;
    const looksLikeOffer =
      (typeof o.id === 'number' || typeof o.id === 'string') &&
      typeof o.title === 'string' &&
      typeof o.url === 'string';
    if (looksLikeOffer) out.push(o);
    for (const key of Object.keys(o)) deepFindOffers(o[key], depth + 1, out);
  }
  return out;
}

/** Best-effort mapping of a loosely-shaped offer object to a RawListing. */
export function mapOffer(o: any, baseUrl: string): RawListing | null {
  try {
    const id = String(o.id);
    const title = String(o.title).trim();
    if (!id || !title) return null;

    const price =
      firstFinite([o?.price?.value, o?.price?.amount, o?.price?.regularPrice?.value, o?.priceUAH]) ??
      toInt(o?.price);
    const area =
      toFloat(o?.area ?? o?.total_area ?? o?.totalArea ?? o?.square) ?? paramArea(o) ?? null;

    return {
      id,
      title,
      price: price ?? null,
      currency: o?.price?.currency ?? o?.currency ?? 'грн',
      area: area === null ? null : Math.round(area),
      city: o?.location?.city?.name ?? o?.city ?? undefined,
      district: o?.location?.district?.name ?? o?.district ?? undefined,
      url: absoluteUrl(String(o.url), baseUrl),
      imageUrl: firstPhoto(o),
      isBusiness: Boolean(o?.business ?? o?.isBusiness ?? o?.user?.isBusiness ?? false),
    };
  } catch {
    return null;
  }
}

function firstFinite(vals: unknown[]): number | null {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function paramArea(o: any): number | null {
  const params = o?.params;
  if (!Array.isArray(params)) return null;
  const p = params.find((x: any) => /area|площ|total/i.test(String(x?.key ?? '')));
  return toFloat(p?.value?.key ?? p?.value?.value ?? p?.value);
}

function firstPhoto(o: any): string | undefined {
  const photos = o?.photos ?? o?.images;
  if (Array.isArray(photos) && photos.length) {
    const first = photos[0];
    const link = typeof first === 'string' ? first : (first?.link ?? first?.url ?? first?.src);
    if (typeof link === 'string') return link.replace('{width}', '640').replace('{height}', '480');
  }
  return o?.image ?? o?.mainPhoto ?? undefined;
}

export interface CardSelectors {
  card: string;
  title: string;
  price: string;
  link: string;
  image?: string;
  location?: string;
}

/**
 * Generic server-rendered-card parser for sites without a usable JSON blob.
 * Selectors are per-site (best-effort). Uses the listing href as the id when no
 * explicit id attribute exists.
 */
export function parseCards(html: string, sel: CardSelectors, baseUrl: string): RawListing[] {
  try {
    const $ = cheerio.load(html);
    const out: RawListing[] = [];
    $(sel.card).each((_, el) => {
      const card = $(el);
      const href = card.find(sel.link).first().attr('href') ?? card.attr('href') ?? '';
      const title = card.find(sel.title).first().text().trim();
      if (!href || !title) return;
      out.push({
        id: idFromHref(href),
        title,
        price: toInt(card.find(sel.price).first().text()),
        currency: 'грн',
        area: null,
        city: sel.location ? card.find(sel.location).first().text().trim() || undefined : undefined,
        district: undefined,
        url: absoluteUrl(href, baseUrl),
        imageUrl: sel.image ? card.find(sel.image).first().attr('src') ?? undefined : undefined,
        isBusiness: false,
      });
    });
    return out;
  } catch {
    return [];
  }
}

/** Derive a stable id from a listing URL (last numeric-ish path segment). */
export function idFromHref(href: string): string {
  const clean = href.split('?')[0].replace(/\/+$/, '');
  const seg = clean.split('/').pop() ?? clean;
  const numeric = seg.match(/\d{4,}/)?.[0];
  return numeric ?? seg ?? clean;
}
