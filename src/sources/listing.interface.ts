/**
 * Source-agnostic listing + search types shared across the whole app.
 *
 * This replaces the old OLX-specific `OlxListing`/`SearchCriteria`. OLX is now
 * just one of several `ListingSource`s (see listing-source.interface.ts).
 */

/** The filter fields a user defines — both the profile criteria and the query
 *  handed to every source. Site-agnostic and flat by design. */
export interface SearchCriteria {
  city: string;
  district?: string;
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
  /** true = private-owner listings only; false = include agencies/realtors.
   *  Used by sources that expose it (e.g. OLX); ignored otherwise. */
  ownerOnly: boolean;
  /** rent (long-term) vs sale — a per-site field (DOM.RIA). Defaults to rent. */
  operation?: 'rent' | 'sale';
  /** Room count filter: 1, 2, 3, or 4 meaning "4+"; undefined = any. */
  rooms?: number;
}

/** A normalized listing before the source tags it (source/sourceLabel added by
 *  the engine). Site parsers produce these. */
export interface RawListing {
  /** Source-local id (unique within that site). Namespaced globally via
   *  `listingKey()` so numeric ids from different sites can't collide. */
  id: string;
  title: string;
  price: number | null;
  currency: string;
  area: number | null;
  /** Number of rooms, when the source publishes it. */
  rooms?: number | null;
  city?: string;
  district?: string;
  url: string;
  imageUrl?: string;
  isBusiness: boolean;
}

/** A listing tagged with which site it came from. */
export interface Listing extends RawListing {
  /** Source id, e.g. 'olx', 'domria'. */
  source: string;
  /** Human label for messages, e.g. 'OLX', 'DOM.RIA'. */
  sourceLabel: string;
}

/**
 * Global dedup key. The seen-hash is keyed by this, NOT the raw id, so the same
 * physical flat listed on two sites is tracked independently and a numeric id
 * reused across sites never collides.
 */
export function listingKey(l: Pick<Listing, 'source' | 'id'>): string {
  return `${l.source}:${l.id}`;
}

// birdrent.com and josti.com.ua were dropped: both are booking-app products with
// no browseable web catalog to scrape (only App Store / Google Play landing
// pages). olx/lun/flatfy stay — they have real adapters but Cloudflare-block the
// droplet's datacenter IP, so they enable once HTTP_PROXY_URL points at a proxy.
/** Every site this build knows about, in default priority order. */
export const KNOWN_SOURCE_IDS = ['olx', 'rieltor', 'domria', 'lun', 'flatfy'] as const;

/** Display labels per source id (for messages that only have the id). */
export const SOURCE_LABELS: Record<string, string> = {
  olx: 'OLX',
  rieltor: 'Rieltor',
  domria: 'DOM.RIA',
  lun: 'ЛУН',
  flatfy: 'Flatfy',
};
