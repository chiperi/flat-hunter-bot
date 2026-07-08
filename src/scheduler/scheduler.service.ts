import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { Listing, listingKey } from '../sources/listing.interface';
import { SourceRegistry } from '../sources/source-registry.service';
import { SeenListingsRepository } from '../persistence/seen-listings.repository';
import { matchesCriteria, SearchProfile } from '../search-profiles/search-profile.model';
import { SearchProfilesService } from '../search-profiles/search-profiles.service';
import { TelegramService } from '../telegram/telegram.service';

/**
 * The polling loop. One self-rescheduling cycle:
 *   1. load all active (non-paused) profiles
 *   2. for every (enabled source × unique request), fetch ONCE and cache — two
 *      profiles that resolve to the same upstream request share the call
 *   3. per profile: gather listings from ALL enabled sources, then diff against
 *      its Redis seen-hash (keyed by `source:id`, so sites can't collide)
 *   4. notify on new / price-changed listings; mark seen only AFTER a send
 *   5. reschedule with jitter
 *
 * Each profile is one search across every site; each alert is tagged with the
 * site it came from. Resilience: every source returns [] on failure, each profile
 * is processed in its own try/catch, and each notification is isolated — so one
 * user's blocked bot, one bad fetch, or one broken source can't stop the loop.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  /** How many current matches to surface on a filter's first poll. */
  private static readonly INITIAL_SHOW = 5;

  private readonly logger = new Logger(SchedulerService.name);
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running = false;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly profiles: SearchProfilesService,
    private readonly seen: SeenListingsRepository,
    private readonly telegram: TelegramService,
    private readonly sources: SourceRegistry,
  ) {
    const polling = config.get('polling', { infer: true });
    this.intervalMs = polling.intervalMs;
    this.jitterMs = polling.jitterMs;
  }

  onModuleInit(): void {
    // Kick off shortly after boot so the bot has connected first.
    this.logger.log(
      `Polling every ~${Math.round(this.intervalMs / 1000)}s (±${Math.round(
        this.jitterMs / 1000,
      )}s jitter)`,
    );
    this.scheduleNext(8000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private nextDelay(): number {
    const jitter = Math.round((Math.random() * 2 - 1) * this.jitterMs); // ±jitter
    return Math.max(5000, this.intervalMs + jitter);
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // A previous cycle overran; skip this beat rather than overlap.
      this.scheduleNext(this.nextDelay());
      return;
    }
    this.running = true;
    try {
      await this.runCycle();
    } catch (err) {
      this.logger.error(`Polling cycle failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
      this.scheduleNext(this.nextDelay());
    }
  }

  /** Exposed for tests/manual triggering. */
  async runCycle(): Promise<void> {
    const all = await this.profiles.listAll();
    const active = all.filter((p) => !p.paused);
    if (active.length === 0) {
      this.logger.debug('No active profiles this cycle.');
      return;
    }

    const sourceIds = this.sources.ids;
    // Fetch each unique (source, upstream request) at most once per cycle and
    // cache it, so profiles that resolve to the same real request share the call
    // — e.g. two users both searching Kyiv rent hit each site once, not twice.
    const cache = new Map<string, Listing[]>();
    const cacheKey = (sourceId: string, criteria: SearchProfile['criteria']) =>
      `${sourceId}::${this.sources.requestKey(sourceId, criteria)}`;
    for (const sourceId of sourceIds) {
      for (const p of active) {
        const key = cacheKey(sourceId, p.criteria);
        if (!cache.has(key)) cache.set(key, await this.sources.fetchOne(sourceId, p.criteria));
      }
    }

    this.logger.debug(
      `Cycle: ${active.length} active profile(s), ${cache.size} unique fetch(es) across ${sourceIds.length} source(s).`,
    );

    for (const profile of active) {
      // One search across every site: merge each source's listings, then diff.
      const listings = sourceIds.flatMap((sid) => cache.get(cacheKey(sid, profile.criteria)) ?? []);
      try {
        await this.processProfile(profile, listings);
      } catch (err) {
        this.logger.error(
          `Profile ${profile.id} (user ${profile.userId}) failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async processProfile(profile: SearchProfile, listings: Listing[]): Promise<void> {
    const matched = listings.filter((l) => matchesCriteria(l, profile.criteria));

    // First ever poll: show the newest few current matches (so a fresh filter
    // isn't empty and the user sees it works), and silently record the rest —
    // avoids a flood while still giving immediate results. Sources return
    // newest-first, so the head of `matched` is the freshest.
    if (!profile.primed) {
      const toShow = matched.slice(0, SchedulerService.INITIAL_SHOW);
      const toSeed = matched.slice(SchedulerService.INITIAL_SHOW);
      await this.seen.seed(
        profile.id,
        toSeed.map((l) => ({ id: listingKey(l), price: l.price })),
      );
      for (const listing of toShow) {
        await this.deliver(profile, listingKey(listing), listing, () =>
          this.telegram.notifyNewListing(profile, listing),
        );
      }
      profile.primed = true;
      await this.profiles.update(profile);
      this.logger.log(
        `Primed profile ${profile.id}: showed ${toShow.length}, seeded ${toSeed.length}.`,
      );
      return;
    }

    const seenMap = await this.seen.getAll(profile.id);

    for (const listing of matched) {
      const key = listingKey(listing); // "source:id" — namespaced across sites
      const stored = seenMap.get(key);

      if (stored === undefined) {
        await this.deliver(profile, key, listing, () =>
          this.telegram.notifyNewListing(profile, listing),
        );
      } else if (stored !== listing.price) {
        await this.deliver(profile, key, listing, () =>
          this.telegram.notifyPriceChange(profile, listing, stored),
        );
      }
      // else: seen and unchanged — nothing to do.
    }
  }

  /**
   * Send, then persist "seen" ONLY on success. If the send throws (blocked bot,
   * rate limit, network) we log and leave it unseen so it retries next cycle —
   * a failed notify is never silently swallowed. Isolated per listing.
   */
  private async deliver(
    profile: SearchProfile,
    key: string,
    listing: Listing,
    send: () => Promise<void>,
  ): Promise<void> {
    try {
      await send();
      await this.seen.markSeen(profile.id, key, listing.price);
    } catch (err) {
      this.logger.warn(
        `Notify failed for ${key} -> user ${profile.userId}: ${
          (err as Error).message
        } (will retry next cycle)`,
      );
    }
  }
}
