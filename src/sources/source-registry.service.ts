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

  /** Ids of the active sources. */
  get ids(): string[] {
    return this.sources.map((s) => s.id);
  }

  has(sourceId: string): boolean {
    return this.sources.some((s) => s.id === sourceId);
  }

  /**
   * The upstream request key for a (source, criteria) — used by the scheduler to
   * dedup profiles that resolve to the same real request. Falls back to the full
   * criteria when a source doesn't define one.
   */
  requestKey(sourceId: string, criteria: SearchCriteria): string {
    const source = this.sources.find((s) => s.id === sourceId);
    return source?.requestKey?.(criteria) ?? JSON.stringify(criteria);
  }

  /**
   * Fetch from a SINGLE source (per-site filters target one site each).
   * Returns [] if the source isn't active or throws.
   */
  async fetchOne(sourceId: string, criteria: SearchCriteria): Promise<Listing[]> {
    const source = this.sources.find((s) => s.id === sourceId);
    if (!source) return [];
    try {
      return await source.fetchListings(criteria);
    } catch (err) {
      this.logger.warn(`Source ${sourceId} threw: ${(err as Error).message}`);
      return [];
    }
  }
}
