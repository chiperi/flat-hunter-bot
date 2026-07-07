import { Inject, Injectable, Logger } from '@nestjs/common';
import { Listing, SearchCriteria } from './listing.interface';
import { LISTING_SOURCES, ListingSource } from './listing-source.interface';

/**
 * Fans a single search out across every active source and merges the results.
 * Sources run concurrently (different hosts), each already returns [] on
 * failure, and this adds a second guard — so one slow or broken site can never
 * stall or fail the whole cycle.
 */
@Injectable()
export class SourceRegistry {
  private readonly logger = new Logger(SourceRegistry.name);

  constructor(@Inject(LISTING_SOURCES) private readonly sources: ListingSource[]) {
    this.logger.log(
      `Active sources (${sources.length}): ${sources.map((s) => s.id).join(', ') || 'none'}`,
    );
  }

  get count(): number {
    return this.sources.length;
  }

  async fetchAll(criteria: SearchCriteria): Promise<Listing[]> {
    const perSource = await Promise.all(
      this.sources.map(async (s) => {
        try {
          return await s.fetchListings(criteria);
        } catch (err) {
          this.logger.warn(`Source ${s.id} threw: ${(err as Error).message}`);
          return [] as Listing[];
        }
      }),
    );
    return perSource.flat();
  }
}
