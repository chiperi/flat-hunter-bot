import { Listing, SearchCriteria } from '../sources/listing.interface';

/**
 * A user's saved search. Persisted as JSON in Redis under
 * `{prefix}:profile:{id}`. Flat by design — no relations.
 */
export interface SearchProfile {
  /** Short random hex id, also used in /pause <id> etc. */
  id: string;
  /** Telegram user who owns it. */
  userId: number;
  /** Chat to deliver notifications to (same as userId for private chats). */
  chatId: number;
  /** Human label shown in /mysearches, defaults to the city/district. */
  name: string;
  criteria: SearchCriteria;
  /** When paused, the scheduler skips it but keeps its data. */
  paused: boolean;
  /**
   * Set true after the first poll seeds the "seen" hash. Until then we record
   * current listings WITHOUT notifying, so activating a profile doesn't blast
   * the user with every listing that already exists — only genuinely new ones
   * from that point on.
   */
  primed: boolean;
  createdAt: number;
}

/**
 * A stable key for the *search itself* (ignoring who owns it / metadata).
 * Two profiles with the same signature hit OLX once per cycle instead of
 * twice — the request-deduplication the brief calls for.
 */
export function searchSignature(c: SearchCriteria): string {
  return [
    c.city.trim().toLowerCase(),
    (c.district ?? '').trim().toLowerCase(),
    c.priceMin ?? '',
    c.priceMax ?? '',
    c.areaMin ?? '',
    c.areaMax ?? '',
    c.ownerOnly ? 'owner' : 'all',
  ].join('|');
}

/**
 * Client-side safety net: even if the scraper's URL filters are imperfect (or
 * a source ignores a param), never notify about something outside the range.
 */
export function matchesCriteria(listing: Listing, c: SearchCriteria): boolean {
  if (c.ownerOnly && listing.isBusiness) return false;

  if (listing.price !== null) {
    if (c.priceMin != null && listing.price < c.priceMin) return false;
    if (c.priceMax != null && listing.price > c.priceMax) return false;
  }

  if (listing.area !== null) {
    if (c.areaMin != null && listing.area < c.areaMin) return false;
    if (c.areaMax != null && listing.area > c.areaMax) return false;
  }

  if (c.district && listing.district) {
    if (!listing.district.toLowerCase().includes(c.district.trim().toLowerCase())) {
      return false;
    }
  }

  return true;
}

/** A friendly default name from the criteria, used when the user doesn't set one. */
export function defaultProfileName(c: SearchCriteria): string {
  const where = c.district ? `${c.city}, ${c.district}` : c.city;
  return where;
}
