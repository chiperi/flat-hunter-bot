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
 * ⚠️ Real HTTP parsing is BEST-EFFORT. None of these sites has a stable public
 * contract for this use case (except DOM.RIA's official API), their markup
 * drifts, and several are SPAs / may block datacenter IPs. Treat every
 * `buildUrl`/`parse` below as a starting point to tune against the live site.
 * All parsers are defensive (return [] on mismatch). `SCRAPER=mock` — the
 * default — sidesteps all of this and exercises the whole pipeline for every
 * source without network.
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
const domria: SiteSpec = {
  id: 'domria',
  label: 'DOM.RIA',
  fetch: async (ctx, c) => {
    const { apiKey, baseUrl } = ctx.cfg.domria;
    if (!apiKey) return []; // no key → nothing to fetch (log-free, expected)

    // Best-effort search params (category 1 = flats, operation 3 = long-term rent).
    const search = new URLSearchParams({ api_key: apiKey, category: '1', operation_type: '3', lang_id: '4' });
    if (c.priceMin != null) search.set('firstIterationBound', String(c.priceMin));
    if (c.priceMax != null) search.set('price_cur', String(c.priceMax));
    const found: any = await ctx.getJson(`${baseUrl}/dom/search?${search.toString()}`);
    // Cap detail fetches — one API call per listing is the biggest amplifier.
    const ids: number[] = Array.isArray(found?.items)
      ? found.items.slice(0, ctx.cfg.domria.maxDetails)
      : [];

    const listings: RawListing[] = [];
    for (const id of ids) {
      try {
        const info: any = await ctx.getJson(`${baseUrl}/dom/info/${id}?api_key=${apiKey}&lang_id=4`);
        const url = info?.beautiful_url
          ? absoluteUrl(String(info.beautiful_url), 'https://dom.ria.com/uk')
          : `https://dom.ria.com/uk/realty-${id}.html`;
        listings.push({
          id: String(id),
          title: String(info?.description_title || info?.beautiful_realty_name || `Квартира ${id}`).trim(),
          price: toInt(info?.price ?? info?.priceArr?.['3'] ?? info?.priceArr?.['1']),
          currency: 'грн',
          area: toFloat(info?.total_square_meters),
          city: info?.city_name ?? undefined,
          district: info?.district_name ?? undefined,
          url,
          imageUrl: info?.main_photo
            ? `https://cdn.riastatic.com/photosnew/dom/photo/${info.main_photo}`
            : undefined,
          isBusiness: info?.is_owner === 0,
        });
      } catch {
        // skip a single bad id
      }
    }
    return listings;
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
