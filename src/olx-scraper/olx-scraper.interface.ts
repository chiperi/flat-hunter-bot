/**
 * The scraping abstraction the rest of the app depends on.
 *
 * Everything else (scheduler, profiles, telegram) talks to `OlxScraper` through
 * the `OLX_SCRAPER` injection token and never knows whether listings came from
 * a live OLX fetch, a proxy, or the in-memory mock. Swapping the strategy is a
 * one-line change in the module provider — exactly the "behind an interface so
 * the approach can change later" requirement from the brief.
 */

export const OLX_SCRAPER = Symbol('OLX_SCRAPER');

/** The filter fields a user defines. This is both the profile's criteria and
 *  the query handed to the scraper. Kept flat on purpose. */
export interface SearchCriteria {
  city: string;
  district?: string;
  priceMin?: number;
  priceMax?: number;
  areaMin?: number;
  areaMax?: number;
  /** true = show only private-owner listings; false = include agencies. */
  ownerOnly: boolean;
}

/** A single normalized listing, whatever the source. */
export interface OlxListing {
  /** Stable OLX listing id — the dedup key. */
  id: string;
  title: string;
  /** null when the listing has no price (e.g. "договірна"). */
  price: number | null;
  currency: string;
  /** Total area in m², or null if not published. */
  area: number | null;
  city?: string;
  district?: string;
  url: string;
  imageUrl?: string;
  /** true when posted by a business/agency, false for a private owner. */
  isBusiness: boolean;
}

export interface OlxScraper {
  /**
   * Fetch the current set of listings matching `criteria`.
   *
   * Contract: implementations MUST NOT throw for expected failures (network
   * error, blocked, empty page, parse mismatch) — return `[]` instead so one
   * bad fetch can never take down the polling loop. Throwing is reserved for
   * genuine programmer error.
   */
  fetchListings(criteria: SearchCriteria): Promise<OlxListing[]>;
}
