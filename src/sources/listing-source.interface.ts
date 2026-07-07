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
  /** Stable id, e.g. 'olx'. */
  readonly id: string;
  /** Human label for notifications, e.g. 'OLX'. */
  readonly label: string;
  fetchListings(criteria: SearchCriteria): Promise<Listing[]>;
}
