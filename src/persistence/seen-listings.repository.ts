import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';
import { REDIS_CLIENT } from './redis.provider';

/**
 * The dedup + price-change store, per the brief.
 *
 * One Redis Hash per profile: {p}:seen:{profileId} -> { listingId: lastPrice }.
 *   - presence of a listingId  => already seen (dedup)
 *   - stored price != current  => price changed, worth re-notifying
 *
 * Prices are stored as strings; a null/absent price is stored as the literal
 * "null" so "договірна" listings still register as seen and don't re-fire.
 */
@Injectable()
export class SeenListingsRepository {
  private readonly prefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppConfig, true>,
  ) {
    this.prefix = config.get('redis', { infer: true }).keyPrefix;
  }

  private seenKey(profileId: string): string {
    return `${this.prefix}:seen:${profileId}`;
  }

  private encode(price: number | null): string {
    return price === null ? 'null' : String(price);
  }

  private decode(raw: string | null): number | null | undefined {
    if (raw === null || raw === undefined) return undefined; // not seen
    if (raw === 'null') return null; // seen, no price
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  /** Whole seen map for a profile, decoded. */
  async getAll(profileId: string): Promise<Map<string, number | null>> {
    const hash = await this.redis.hgetall(this.seenKey(profileId));
    const map = new Map<string, number | null>();
    for (const [id, raw] of Object.entries(hash)) {
      const price = this.decode(raw);
      if (price !== undefined) map.set(id, price);
    }
    return map;
  }

  /** True if this profile has never recorded anything (fresh / not primed). */
  async isEmpty(profileId: string): Promise<boolean> {
    const len = await this.redis.hlen(this.seenKey(profileId));
    return len === 0;
  }

  /** Record/refresh a single listing's price. Called AFTER a successful send. */
  async markSeen(profileId: string, listingId: string, price: number | null): Promise<void> {
    await this.redis.hset(this.seenKey(profileId), listingId, this.encode(price));
  }

  /**
   * Bulk-seed many listings at once without notifying. Used to prime a fresh
   * profile on its first poll so the user isn't flooded with pre-existing ads.
   */
  async seed(profileId: string, listings: { id: string; price: number | null }[]): Promise<void> {
    if (listings.length === 0) return;
    const pairs: string[] = [];
    for (const l of listings) {
      pairs.push(l.id, this.encode(l.price));
    }
    await this.redis.hset(this.seenKey(profileId), ...pairs);
  }

  /** Drop the whole seen hash for a profile (on delete / forgetme). */
  async clear(profileId: string): Promise<void> {
    await this.redis.del(this.seenKey(profileId));
  }
}
