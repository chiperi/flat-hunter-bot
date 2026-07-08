import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ProfilesRepository } from '../persistence/profiles.repository';
import { SeenListingsRepository } from '../persistence/seen-listings.repository';
import { SearchCriteria } from '../sources/listing.interface';
import { defaultProfileName, SearchProfile } from './search-profile.model';

/**
 * CRUD + lifecycle for user search profiles. The only place profile ids are
 * minted and the only place that keeps the profile record and its seen-hash
 * consistent (delete removes both).
 */
@Injectable()
export class SearchProfilesService {
  private readonly logger = new Logger(SearchProfilesService.name);

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly seen: SeenListingsRepository,
  ) {}

  /** 8 hex chars — short enough to type in /pause, wide enough to not collide. */
  private newId(): string {
    return randomBytes(4).toString('hex');
  }

  /**
   * Internal — mints a brand-new profile. NOT public: the only way to add a
   * filter is `upsertForSource`, which enforces the one-filter-per-site rule.
   */
  private async create(
    userId: number,
    chatId: number,
    source: string,
    criteria: SearchCriteria,
    name?: string,
  ): Promise<SearchProfile> {
    const profile: SearchProfile = {
      id: this.newId(),
      userId,
      chatId,
      source,
      name: name?.trim() || defaultProfileName(criteria),
      criteria,
      paused: false,
      primed: false,
      createdAt: Date.now(),
    };
    await this.profiles.save(profile);
    this.logger.log(`Created ${source} profile ${profile.id} for user ${userId}`);
    return profile;
  }

  /** The user's existing filter for a site, if any (one filter per site). */
  async findByUserAndSource(userId: number, source: string): Promise<SearchProfile | null> {
    const list = await this.profiles.listByUser(userId);
    return list.find((p) => p.source === source) ?? null;
  }

  /**
   * Create or overwrite the user's single filter for a site: if one exists,
   * update its criteria/name in place (keeps id + primed state); else create.
   */
  async upsertForSource(
    userId: number,
    chatId: number,
    source: string,
    criteria: SearchCriteria,
    name?: string,
  ): Promise<SearchProfile> {
    const existing = await this.findByUserAndSource(userId, source);
    if (existing) {
      existing.criteria = criteria;
      existing.name = name?.trim() || defaultProfileName(criteria);
      existing.primed = false; // re-prime with the new criteria
      await this.profiles.save(existing);
      this.logger.log(`Updated ${source} profile ${existing.id} for user ${userId}`);
      return existing;
    }
    return this.create(userId, chatId, source, criteria, name);
  }

  get(id: string): Promise<SearchProfile | null> {
    return this.profiles.get(id);
  }

  listByUser(userId: number): Promise<SearchProfile[]> {
    return this.profiles.listByUser(userId);
  }

  listAll(): Promise<SearchProfile[]> {
    return this.profiles.listAll();
  }

  /** Persist mutations to an already-loaded profile. */
  async update(profile: SearchProfile): Promise<void> {
    await this.profiles.save(profile);
  }

  async setPaused(id: string, userId: number, paused: boolean): Promise<SearchProfile | null> {
    const profile = await this.profiles.get(id);
    if (!profile || profile.userId !== userId) return null;
    profile.paused = paused;
    await this.profiles.save(profile);
    return profile;
  }

  /** Delete a single profile (and its seen hash), guarded by ownership. */
  async delete(id: string, userId: number): Promise<boolean> {
    const profile = await this.profiles.get(id);
    if (!profile || profile.userId !== userId) return false;
    await this.profiles.delete(profile);
    await this.seen.clear(profile.id);
    this.logger.log(`Deleted profile ${id} for user ${userId}`);
    return true;
  }

  /** /forgetme — wipe every profile + seen hash a user owns. Returns the count. */
  async forgetUser(userId: number): Promise<number> {
    const ids = await this.profiles.listIdsByUser(userId);
    for (const id of ids) {
      const profile = await this.profiles.get(id);
      if (profile) {
        await this.profiles.delete(profile);
        await this.seen.clear(profile.id);
      }
    }
    this.logger.log(`Forgot ${ids.length} profile(s) for user ${userId}`);
    return ids.length;
  }
}
