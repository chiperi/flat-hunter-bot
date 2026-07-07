import { Global, Module } from '@nestjs/common';
import { RedisLifecycle, redisClientProvider } from './redis.provider';
import { ProfilesRepository } from './profiles.repository';
import { SeenListingsRepository } from './seen-listings.repository';

/**
 * Global so the single Redis connection + repositories are injectable
 * everywhere without re-importing this module.
 */
@Global()
@Module({
  providers: [redisClientProvider, RedisLifecycle, ProfilesRepository, SeenListingsRepository],
  exports: [redisClientProvider, ProfilesRepository, SeenListingsRepository],
})
export class PersistenceModule {}
