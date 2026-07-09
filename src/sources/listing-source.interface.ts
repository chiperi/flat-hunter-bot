import { Listing, SearchCriteria } from './listing.interface';

/** Injection token for the array of active `ListingSource`s. */
export const LISTING_SOURCES = Symbol('LISTING_SOURCES');

/**
 * The abstraction the scheduler depends on. Each site is one implementation.
 *
 * Contract: `fetchListings` MUST NOT throw for expected failures (network,
 * blocked, empty, parse mismatch) — return `[]` so one bad source can never
 * take down the polling loop or the other sources.
 */
export interface ListingSource {
  /** Stable id, e.g. 'domria'. */
  readonly id: string;
  /** Human label for notifications, e.g. 'DOM.RIA'. */
  readonly label: string;
  fetchListings(criteria: SearchCriteria): Promise<Listing[]>;
  /**
   * Key identifying the ACTUAL upstream request for these criteria. Two profiles
   * whose criteria differ only in fields the source filters client-side (e.g.
   * DOM.RIA price/area) yield the same key, so the scheduler fetches once and
   * shares the result — saving API quota. Optional; defaults to the full
   * criteria (no extra dedup).
   */
  requestKey?(criteria: SearchCriteria): string;
}
