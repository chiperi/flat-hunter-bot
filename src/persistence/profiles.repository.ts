import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';
import { SearchProfile } from '../search-profiles/search-profile.model';
import { REDIS_CLIENT } from './redis.provider';

/**
 * Repository-style access to search profiles.
 *
 * Key layout ({p} = configured prefix):
 *   {p}:profile:{profileId}        -> JSON(SearchProfile)
 *   {p}:user:{userId}:profiles     -> Set<profileId>   (a user's own profiles)
 *   {p}:profiles:all               -> Set<profileId>   (every profile, for the scheduler)
 */
@Injectable()
export class ProfilesRepository {
  private readonly prefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppConfig, true>,
  ) {
    this.prefix = config.get('redis', { infer: true }).keyPrefix;
  }

  private profileKey(id: string): string {
    return `${this.prefix}:profile:${id}`;
  }

  private userSetKey(userId: number): string {
    return `${this.prefix}:user:${userId}:profiles`;
  }

  private allSetKey(): string {
    return `${this.prefix}:profiles:all`;
  }

  async save(profile: SearchProfile): Promise<void> {
    await this.redis
      .multi()
      .set(this.profileKey(profile.id), JSON.stringify(profile))
      .sadd(this.userSetKey(profile.userId), profile.id)
      .sadd(this.allSetKey(), profile.id)
      .exec();
  }

  async get(id: string): Promise<SearchProfile | null> {
    const raw = await this.redis.get(this.profileKey(id));
    return raw ? (JSON.parse(raw) as SearchProfile) : null;
  }

  async listByUser(userId: number): Promise<SearchProfile[]> {
    const ids = await this.redis.smembers(this.userSetKey(userId));
    return this.loadMany(ids);
  }

  async listAll(): Promise<SearchProfile[]> {
    const ids = await this.redis.smembers(this.allSetKey());
    return this.loadMany(ids);
  }

  /**
   * Delete a single profile: its JSON, its membership in both sets, and its
   * seen-listings hash (handled by SeenListingsRepository via the caller).
   */
  async delete(profile: SearchProfile): Promise<void> {
    await this.redis
      .multi()
      .del(this.profileKey(profile.id))
      .srem(this.userSetKey(profile.userId), profile.id)
      .srem(this.allSetKey(), profile.id)
      .exec();
  }

  /** Ids of every profile a user owns (used by /forgetme). */
  async listIdsByUser(userId: number): Promise<string[]> {
    return this.redis.smembers(this.userSetKey(userId));
  }

  private async loadMany(ids: string[]): Promise<SearchProfile[]> {
    if (ids.length === 0) return [];
    const keys = ids.map((id) => this.profileKey(id));
    const raws = await this.redis.mget(keys);
    const profiles: SearchProfile[] = [];
    for (const raw of raws) {
      if (raw) profiles.push(JSON.parse(raw) as SearchProfile);
    }
    // Newest first — nicer for /mysearches.
    return profiles.sort((a, b) => b.createdAt - a.createdAt);
  }
}
