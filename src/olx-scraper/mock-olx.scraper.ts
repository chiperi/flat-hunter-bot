import { Injectable, Logger } from '@nestjs/common';
import { OlxListing, OlxScraper, SearchCriteria } from './olx-scraper.interface';
import { searchSignature } from '../search-profiles/search-profile.model';

/**
 * A network-free scraper for local dev and CI.
 *
 * It fabricates a *stable* pool of listings per search (seeded from the search
 * signature) so repeated polls of the same profile are consistent, then layers
 * on time-based change so the notification pipeline actually has something to
 * do over successive cycles:
 *   - a "fresh" listing whose id rotates every ~10 minutes  -> exercises "new listing"
 *   - one pool listing whose price drifts every ~10 minutes -> exercises "price change"
 *
 * Selected by SCRAPER=mock. Swap to the http scraper for real data.
 */
@Injectable()
export class MockOlxScraper implements OlxScraper {
  private readonly logger = new Logger(MockOlxScraper.name);

  async fetchListings(criteria: SearchCriteria): Promise<OlxListing[]> {
    const sig = searchSignature(criteria);
    const rand = mulberry32(hashString(sig));

    const poolSize = 5 + Math.floor(rand() * 4); // 5–8 stable listings
    const bucket = Math.floor(Date.now() / (10 * 60 * 1000)); // 10-min time bucket

    const listings: OlxListing[] = [];
    for (let i = 0; i < poolSize; i++) {
      listings.push(this.buildListing(criteria, sig, rand, i, bucket));
    }

    // A brand-new listing that appears each 10-min bucket -> triggers "new".
    listings.push(this.buildListing(criteria, `${sig}#fresh`, mulberry32(bucket), 99, bucket));

    // Only return listings that actually match — the mock respects the filters
    // so the client-side matcher and the "owner-only" toggle are demonstrable.
    const matched = listings.filter((l) => this.roughlyMatches(l, criteria));
    this.logger.debug(`[mock] ${matched.length} listing(s) for "${sig}"`);
    return matched;
  }

  private buildListing(
    criteria: SearchCriteria,
    seedStr: string,
    rand: () => number,
    index: number,
    bucket: number,
  ): OlxListing {
    const id = `mock-${hashString(seedStr)}-${index}`;

    const minPrice = criteria.priceMin ?? 6000;
    const maxPrice = criteria.priceMax ?? 20000;
    let price = Math.round((minPrice + rand() * Math.max(0, maxPrice - minPrice)) / 100) * 100;

    // Make listing #0's price drift with the time bucket -> "price change".
    if (index === 0) {
      price += (bucket % 5) * 250;
    }

    const minArea = criteria.areaMin ?? 30;
    const maxArea = criteria.areaMax ?? 80;
    const area = Math.round(minArea + rand() * Math.max(0, maxArea - minArea));

    const rooms = 1 + Math.floor(rand() * 3);
    const isBusiness = !criteria.ownerOnly && rand() < 0.5;

    return {
      id,
      title: `${rooms}-кімнатна квартира, ${area} м²`,
      price,
      currency: 'грн',
      area,
      city: criteria.city,
      district: criteria.district || 'Центр',
      url: `https://www.olx.ua/d/uk/obyavlenie/${id}.html`,
      imageUrl: `https://picsum.photos/seed/${id}/600/400`,
      isBusiness,
    };
  }

  private roughlyMatches(l: OlxListing, c: SearchCriteria): boolean {
    if (c.ownerOnly && l.isBusiness) return false;
    if (l.price !== null) {
      if (c.priceMin != null && l.price < c.priceMin) return false;
      if (c.priceMax != null && l.price > c.priceMax) return false;
    }
    return true;
  }
}

/** FNV-1a-ish string hash -> uint32, for seeding the PRNG deterministically. */
function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG so a given seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
