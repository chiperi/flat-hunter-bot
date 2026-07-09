import { SourcesConfig } from '../config/configuration';
import { RawListing, SearchCriteria } from './listing.interface';
import { SiteSpec } from './http-listing-source';
import {
  absoluteUrl,
  CardSelectors,
  deepFindOffers,
  extractNextData,
  mapOffer,
  parseCards,
  parseRieltor,
  toFloat,
  toInt,
} from './parsing.util';

/**
 * One spec per tracked site. Three remain: DOM.RIA (official API) and Rieltor
 * (server-rendered HTML) are the live, tuned sources; OLX has a real adapter but
 * Cloudflare-blocks the droplet's datacenter IP (403), so it only runs behind a
 * residential proxy (`HTTP_PROXY_URL`).
 *
 * ⚠️ The HTML parsers are BEST-EFFORT — markup drifts, so they're all defensive
 * (return [] on mismatch) and expected to be tuned against the live site.
 */

/** Shared "try __NEXT_DATA__ JSON, then fall back to HTML cards" parser. */
function nextDataThenCards(html: string, baseUrl: string, cards: CardSelectors): RawListing[] {
  const data = extractNextData(html);
  if (data) {
    const offers = deepFindOffers(data)
      .map((o) => mapOffer(o, baseUrl))
      .filter((l): l is RawListing => l !== null);
    if (offers.length) return offers;
  }
  return parseCards(html, cards, baseUrl);
}

function priceAreaQuery(c: SearchCriteria, names: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams();
  const loc = [c.city, c.district].filter(Boolean).join(' ').trim();
  if (loc && names.q) p.set(names.q, loc);
  if (c.priceMin != null && names.priceMin) p.set(names.priceMin, String(c.priceMin));
  if (c.priceMax != null && names.priceMax) p.set(names.priceMax, String(c.priceMax));
  if (c.areaMin != null && names.areaMin) p.set(names.areaMin, String(c.areaMin));
  if (c.areaMax != null && names.areaMax) p.set(names.areaMax, String(c.areaMax));
  return p;
}

// --- OLX (well-trodden: __NEXT_DATA__ then cards) --------------------------
const olx: SiteSpec = {
  id: 'olx',
  label: 'OLX',
  kind: 'html',
  buildUrl: (c, cfg) => {
    const base = cfg.olx.baseUrl.replace(/\/+$/, '');
    const path = cfg.olx.categoryPath.replace(/^\/+|\/+$/g, '');
    const p = new URLSearchParams();
    const q = [c.city, c.district].filter(Boolean).join(' ').trim();
    if (q) p.set('q', q);
    if (c.priceMin != null) p.set('search[filter_float_price:from]', String(c.priceMin));
    if (c.priceMax != null) p.set('search[filter_float_price:to]', String(c.priceMax));
    if (c.areaMin != null) p.set('search[filter_float_total_area:from]', String(c.areaMin));
    if (c.areaMax != null) p.set('search[filter_float_total_area:to]', String(c.areaMax));
    if (c.ownerOnly) p.set('search[private_business]', 'private');
    p.set('search[order]', 'created_at:desc');
    return `${base}/${path}/?${p.toString()}`;
  },
  parse: (html, cfg) =>
    nextDataThenCards(html, cfg.olx.baseUrl, {
      card: '[data-cy="l-card"]',
      title: '[data-cy="ad-card-title"], h6, h4',
      price: '[data-testid="ad-price"]',
      link: 'a[href]',
      image: 'img',
      location: '[data-testid="location-date"]',
    }),
};

// --- rieltor.ua ------------------------------------------------------------
// Server-rendered HTML (not Next.js); reachable from the droplet (unlike OLX).
// URL filters are real and verified live: price_min/price_max, rooms=N (exact
// 1–3), f-owners=1. Area has no working URL param → filtered client-side. City
// is Kyiv-only for now (the default flats-rent/ path). Newest-first, ~20 cards.
function rieltorUrl(c: SearchCriteria): string {
  const seg = c.operation === 'sale' ? 'flats-sale' : 'flats-rent';
  const p = new URLSearchParams();
  if (c.priceMin != null) p.set('price_min', String(c.priceMin));
  if (c.priceMax != null) p.set('price_max', String(c.priceMax));
  // rooms=N filters an exact count; "4+" (rooms>=4) has no URL form → client-side.
  if (c.rooms != null && c.rooms >= 1 && c.rooms <= 3) p.set('rooms', String(c.rooms));
  if (c.ownerOnly) p.set('f-owners', '1');
  const qs = p.toString();
  return `https://rieltor.ua/${seg}/${qs ? `?${qs}` : ''}`;
}

const rieltor: SiteSpec = {
  id: 'rieltor',
  label: 'Rieltor',
  kind: 'html',
  buildUrl: (c) => rieltorUrl(c),
  parse: (html) => parseRieltor(html, 'https://rieltor.ua'),
};

// --- DOM.RIA (official API — real data when DOMRIA_API_KEY is set) ---------
//
// RIA filters location by numeric geo ids (verified against the live API), so a
// free-text city can't be passed directly. This small map covers the common
// cities; an unmapped city is skipped (returning all-Ukraine would flood the
// user, since the client-side filter doesn't match RIA's Russian place names).
// Extend as needed — the search endpoint takes state_id + city_id.
export const DOMRIA_CITY_GEO: Record<string, { state: number; city: number }> = {
  київ: { state: 10, city: 10 },
  киев: { state: 10, city: 10 },
  kyiv: { state: 10, city: 10 },
};

function domriaGeo(city: string): { state: number; city: number } | null {
  return DOMRIA_CITY_GEO[city.trim().toLowerCase()] ?? null;
}

function domriaTitle(info: any, id: number | string): string {
  const area = toFloat(info?.total_square_meters);
  return [
    info?.rooms_count ? `${info.rooms_count}-кімн.` : `Квартира ${id}`,
    area ? `${Math.round(area)} м²` : null,
    info?.street_name || info?.district_name || null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** RIA photo CDN: base "photos" + a size suffix before .jpg (verified live). */
function domriaPhoto(mainPhoto?: string): string | undefined {
  if (!mainPhoto) return undefined;
  return `https://cdn.riastatic.com/photos/${String(mainPhoto).replace(/(\.jpg)$/i, 'b$1')}`;
}

/**
 * Price in hryvnia, whatever currency the seller listed in. DOM.RIA returns the
 * same price in every currency via `priceArr` — key "3" is always UAH (1=USD,
 * 2=EUR, 3=UAH), already converted at the current rate. So we never rely on the
 * raw `price` (which is in the seller's currency) and never mislabel $/€ as грн.
 */
function domriaUahPrice(info: any): number | null {
  const uah = toInt(info?.priceArr?.['3']); // "25 000" → 25000 (toInt strips spaces)
  if (uah != null) return uah;
  // No UAH figure → trust `price` only when it's already hryvnia.
  if (toInt(info?.currency_type_id) === 3) return toInt(info?.price ?? info?.price_total);
  return null; // foreign price with no UAH value → "Ціна договірна", not a wrong number
}

function mapDomriaInfo(info: any, id: number | string): RawListing {
  const area = toFloat(info?.total_square_meters);
  return {
    id: String(id),
    title: domriaTitle(info, id),
    price: domriaUahPrice(info),
    currency: 'грн',
    area: area === null ? null : Math.round(area),
    rooms: toInt(info?.rooms_count),
    city: info?.city_name ?? undefined,
    // RIA's district is a neighbourhood, not the admin raion the user picks —
    // leave it unset so DOM.RIA filters by city + price + area + rooms only.
    district: undefined,
    url: info?.beautiful_url
      ? absoluteUrl(String(info.beautiful_url), 'https://dom.ria.com/uk')
      : `https://dom.ria.com/uk/realty-${id}.html`,
    imageUrl: domriaPhoto(info?.main_photo),
    isBusiness: Boolean(info?.advert_type_id === 2 || info?.is_owner === 0),
  };
}

/**
 * Opt-2: per-(city+operation) cache so each cycle fetches details ONLY for
 * genuinely-new listings, not the same top-N every time. The limited API budget
 * is then spent on real newcomers → every new listing gets checked against all
 * users' filters. In-memory (per process); resets on restart, then re-fills.
 */
const DOMRIA_SEARCH_WINDOW = 100; // newest ids we monitor
const DOMRIA_CACHE_SIZE = 60; // recent listings we keep + return
interface DomriaCache {
  known: Set<string>; // ids we've already fetched details for
  recent: RawListing[]; // recent listings (newest first)
}
export const domriaCaches = new Map<string, DomriaCache>();

const domria: SiteSpec = {
  id: 'domria',
  label: 'DOM.RIA',
  // The search URL depends on city (geo) + operation + PRICE (price is pushed into
  // the API request — see fetch). Area/rooms are still client-side, so profiles
  // differing only in those share one fetch. The scheduler dedups on this key.
  requestKey: (c) =>
    `${(c.city ?? '').trim().toLowerCase()}|${c.operation ?? 'rent'}|${c.priceMin ?? ''}|${c.priceMax ?? ''}`,
  fetch: async (ctx, c) => {
    const { apiKey, baseUrl } = ctx.cfg.domria;
    if (!apiKey) return []; // no key → nothing to fetch (expected)

    const geo = domriaGeo(c.city);
    if (!geo) return []; // unmapped city → skip rather than flood with all-Ukraine

    const op = c.operation === 'sale' ? '1' : '3'; // RIA operation types
    const priceFrom = c.priceMin != null ? String(c.priceMin) : '';
    const priceTo = c.priceMax != null ? String(c.priceMax) : '';
    // Cache is per unique search, so different price ranges don't share ids.
    const cacheKey = `${geo.state}:${geo.city}:${op}:${priceFrom}:${priceTo}`;
    let cache = domriaCaches.get(cacheKey);
    if (!cache) {
      cache = { known: new Set(), recent: [] };
      domriaCaches.set(cacheKey, cache);
    }

    // 1 search request → newest-first ids. Push price into the request: DOM.RIA
    // filters on the UAH-equivalent (it converts $/€, matching our client-side
    // priceArr[3] logic), so the limited detail budget lands on listings in the
    // user's budget instead of random newest ones (verified live).
    const search = new URLSearchParams({
      api_key: apiKey,
      category: '1',
      operation_type: op,
      state_id: String(geo.state),
      city_id: String(geo.city),
      lang_id: '4',
    });
    if (priceFrom) search.set('price_from', priceFrom);
    if (priceTo) search.set('price_to', priceTo);
    const found: any = await ctx.getJson(`${baseUrl}/dom/search?${search.toString()}`);
    const window: string[] = (Array.isArray(found?.items) ? found.items : [])
      .slice(0, DOMRIA_SEARCH_WINDOW)
      .map(String);

    // Fetch details ONLY for ids we haven't seen — capped per cycle by the budget.
    const newIds = window.filter((id) => !cache!.known.has(id)).slice(0, ctx.cfg.domria.maxDetails);
    for (const id of newIds) {
      try {
        const info: any = await ctx.getJson(`${baseUrl}/dom/info/${id}?api_key=${apiKey}&lang_id=4`);
        cache.recent.unshift(mapDomriaInfo(info, id));
      } catch {
        // ignore this id's details
      }
      cache.known.add(id); // mark known either way so a bad id isn't retried forever
    }

    // Bound memory: cap recent, and prune `known` to the current search window
    // (older ids won't reappear since ids are monotonic).
    if (cache.recent.length > DOMRIA_CACHE_SIZE) {
      cache.recent = cache.recent.slice(0, DOMRIA_CACHE_SIZE);
    }
    const windowSet = new Set(window);
    cache.known = new Set([...cache.known].filter((id) => windowSet.has(id)));

    return [...cache.recent];
  },
};

/** All specs, keyed by id — the module builds a source per ENABLED id. */
export const SITE_SPECS: Record<string, SiteSpec> = {
  olx,
  rieltor,
  domria,
};
