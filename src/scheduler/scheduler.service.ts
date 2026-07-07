import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { OLX_SCRAPER, OlxListing, OlxScraper } from '../olx-scraper/olx-scraper.interface';
import { SeenListingsRepository } from '../persistence/seen-listings.repository';
import {
  matchesCriteria,
  searchSignature,
  SearchProfile,
} from '../search-profiles/search-profile.model';
import { SearchProfilesService } from '../search-profiles/search-profiles.service';
import { TelegramService } from '../telegram/telegram.service';

/**
 * The polling loop. One self-rescheduling cycle:
 *   1. load all active (non-paused) profiles
 *   2. group them by search signature so identical searches hit OLX ONCE
 *   3. per group: fetch, then diff each profile against its Redis seen-hash
 *   4. notify on new / price-changed listings; mark seen only AFTER a send
 *   5. reschedule with jitter
 *
 * Resilience: the scraper never throws (returns []), each profile is processed
 * in its own try/catch, and each notification is isolated — so one user's
 * blocked bot or one bad fetch can't stop the loop for everyone else.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
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
    @Inject(OLX_SCRAPER) private readonly scraper: OlxScraper,
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

    // Group by search signature to dedupe OLX fetches.
    const groups = new Map<string, SearchProfile[]>();
    for (const p of active) {
      const sig = searchSignature(p.criteria);
      const bucket = groups.get(sig);
      if (bucket) bucket.push(p);
      else groups.set(sig, [p]);
    }

    this.logger.debug(
      `Cycle: ${active.length} active profile(s) across ${groups.size} unique search(es).`,
    );

    for (const bucket of groups.values()) {
      // Every profile in a bucket shares identical criteria.
      const listings = await this.scraper.fetchListings(bucket[0].criteria);
      for (const profile of bucket) {
        try {
          await this.processProfile(profile, listings);
        } catch (err) {
          this.logger.error(
            `Profile ${profile.id} (user ${profile.userId}) failed: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  private async processProfile(profile: SearchProfile, listings: OlxListing[]): Promise<void> {
    const matched = listings.filter((l) => matchesCriteria(l, profile.criteria));

    // First ever poll: seed the seen-hash silently so activating a profile
    // doesn't blast the user with every pre-existing listing.
    if (!profile.primed) {
      await this.seen.seed(
        profile.id,
        matched.map((l) => ({ id: l.id, price: l.price })),
      );
      profile.primed = true;
      await this.profiles.update(profile);
      this.logger.log(
        `Primed profile ${profile.id} with ${matched.length} existing listing(s).`,
      );
      return;
    }

    const seenMap = await this.seen.getAll(profile.id);

    for (const listing of matched) {
      const stored = seenMap.get(listing.id);

      if (stored === undefined) {
        await this.deliver(profile, listing, () =>
          this.telegram.notifyNewListing(profile, listing),
        );
      } else if (stored !== listing.price) {
        await this.deliver(profile, listing, () =>
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
    listing: OlxListing,
    send: () => Promise<void>,
  ): Promise<void> {
    try {
      await send();
      await this.seen.markSeen(profile.id, listing.id, listing.price);
    } catch (err) {
      this.logger.warn(
        `Notify failed for listing ${listing.id} -> user ${profile.userId}: ${
          (err as Error).message
        } (will retry next cycle)`,
      );
    }
  }
}
