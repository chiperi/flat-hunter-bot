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
  toFloat,
  toInt,
} from './parsing.util';

/**
 * One spec per tracked site.
 *
 * ⚠️ The HTML parsers are BEST-EFFORT. None of these sites has a stable public
 * contract for this use case (except DOM.RIA's official API), their markup
 * drifts, and several are SPAs / may block datacenter IPs. Treat every
 * `buildUrl`/`parse` below as a starting point to tune against the live site.
 * All parsers are defensive (return [] on mismatch). DOM.RIA is the tuned,
 * working source; the others are wired but not yet driven by the wizard.
 *
 * Note on overlap: lun.ua and flatfy.ua are the same company (LUN), and Flatfy
 * is itself an aggregator that already pulls OLX + DOM.RIA — enabling all of
 * them will surface the same physical flat more than once (dedup is per source,
 * so each fires independently). Trim `SOURCES` if that's noisy.
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
const rieltor: SiteSpec = {
  id: 'rieltor',
  label: 'Rieltor',
  kind: 'html',
  buildUrl: (c) => {
    const p = priceAreaQuery(c, {
      q: 'q',
      priceMin: 'price_min',
      priceMax: 'price_max',
      areaMin: 'area_min',
      areaMax: 'area_max',
    });
    return `https://rieltor.ua/flats-rent/?${p.toString()}`;
  },
  parse: (html) =>
    nextDataThenCards(html, 'https://rieltor.ua', {
      card: '.catalog-card, [class*="offer-card"]',
      title: '.offer-title, h3, h2',
      price: '[class*="price"]',
      link: 'a[href]',
      image: 'img',
    }),
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

function mapDomriaInfo(info: any, id: number | string): RawListing {
  const area = toFloat(info?.total_square_meters);
  return {
    id: String(id),
    title: domriaTitle(info, id),
    price: toInt(info?.price ?? info?.priceArr?.['3']),
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
  // The search API URL depends only on city (geo) + operation; price/area/rooms
  // are filtered client-side. So two profiles differing only in those share one
  // fetch — the scheduler dedups on this key to save API quota.
  requestKey: (c) => `${(c.city ?? '').trim().toLowerCase()}|${c.operation ?? 'rent'}`,
  fetch: async (ctx, c) => {
    const { apiKey, baseUrl } = ctx.cfg.domria;
    if (!apiKey) return []; // no key → nothing to fetch (expected)

    const geo = domriaGeo(c.city);
    if (!geo) return []; // unmapped city → skip rather than flood with all-Ukraine

    const op = c.operation === 'sale' ? '1' : '3'; // RIA operation types
    const cacheKey = `${geo.state}:${geo.city}:${op}`;
    let cache = domriaCaches.get(cacheKey);
    if (!cache) {
      cache = { known: new Set(), recent: [] };
      domriaCaches.set(cacheKey, cache);
    }

    // 1 search request → newest-first ids.
    const search = new URLSearchParams({
      api_key: apiKey,
      category: '1',
      operation_type: op,
      state_id: String(geo.state),
      city_id: String(geo.city),
      lang_id: '4',
    });
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

// --- lun.ua (SPA on LUN's backend) -----------------------------------------
const lun: SiteSpec = {
  id: 'lun',
  label: 'ЛУН',
  kind: 'html',
  buildUrl: (c) => {
    const p = priceAreaQuery(c, {
      q: 'geo',
      priceMin: 'price_from',
      priceMax: 'price_to',
      areaMin: 'area_total_from',
      areaMax: 'area_total_to',
    });
    return `https://lun.ua/uk/оренда-квартир?${p.toString()}`;
  },
  parse: (html) =>
    nextDataThenCards(html, 'https://lun.ua', {
      card: '[class*="card"], article',
      title: 'h3, h2, [class*="title"]',
      price: '[class*="price"]',
      link: 'a[href]',
      image: 'img',
    }),
};

// --- flatfy.ua (same LUN backend; overlaps lun + aggregates OLX/DOM.RIA) ----
const flatfy: SiteSpec = {
  id: 'flatfy',
  label: 'Flatfy',
  kind: 'html',
  buildUrl: (c) => {
    const p = priceAreaQuery(c, {
      q: 'geo',
      priceMin: 'price_from',
      priceMax: 'price_to',
      areaMin: 'area_total_from',
      areaMax: 'area_total_to',
    });
    return `https://flatfy.ua/uk/оренда-квартир?${p.toString()}`;
  },
  parse: (html) =>
    nextDataThenCards(html, 'https://flatfy.ua', {
      card: '[class*="card"], article',
      title: 'h3, h2, [class*="title"]',
      price: '[class*="price"]',
      link: 'a[href]',
      image: 'img',
    }),
};

// --- birdrent.com ----------------------------------------------------------
const birdrent: SiteSpec = {
  id: 'birdrent',
  label: 'BirdRent',
  kind: 'html',
  buildUrl: (c) => {
    const p = priceAreaQuery(c, {
      q: 'q',
      priceMin: 'price_from',
      priceMax: 'price_to',
      areaMin: 'area_from',
      areaMax: 'area_to',
    });
    return `https://birdrent.com/?${p.toString()}`;
  },
  parse: (html) =>
    nextDataThenCards(html, 'https://birdrent.com', {
      card: '[class*="card"], [class*="listing"], article',
      title: 'h3, h2, [class*="title"]',
      price: '[class*="price"]',
      link: 'a[href]',
      image: 'img',
    }),
};

// --- josti.com.ua ----------------------------------------------------------
const josti: SiteSpec = {
  id: 'josti',
  label: 'Josti',
  kind: 'html',
  buildUrl: (c) => {
    const p = priceAreaQuery(c, {
      q: 'q',
      priceMin: 'price_from',
      priceMax: 'price_to',
      areaMin: 'area_from',
      areaMax: 'area_to',
    });
    return `https://www.josti.com.ua/?${p.toString()}`;
  },
  parse: (html) =>
    nextDataThenCards(html, 'https://www.josti.com.ua', {
      card: '[class*="card"], [class*="listing"], article',
      title: 'h3, h2, [class*="title"]',
      price: '[class*="price"]',
      link: 'a[href]',
      image: 'img',
    }),
};

/** All specs, keyed by id — the module builds a source per ENABLED id. */
export const SITE_SPECS: Record<string, SiteSpec> = {
  olx,
  rieltor,
  domria,
  lun,
  flatfy,
  birdrent,
  josti,
};
