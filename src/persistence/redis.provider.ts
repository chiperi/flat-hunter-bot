import {
  FactoryProvider,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * A single shared ioredis connection, created from config. Exposed via the
 * `REDIS_CLIENT` token so repositories inject the raw client without every
 * module re-reading connection settings.
 */
export const redisClientProvider: FactoryProvider<Redis> = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => {
    const logger = new Logger('Redis');
    const { url } = config.get('redis', { infer: true });

    const client = new Redis(url, {
      // Keep retrying forever with capped backoff — a transient redis blip
      // must not kill the bot.
      retryStrategy: (times) => Math.min(times * 500, 5000),
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    client.on('connect', () => logger.log(`Connected to Redis at ${url}`));
    client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
    client.on('reconnecting', () => logger.warn('Reconnecting to Redis...'));

    return client;
  },
};

/**
 * Closes the Redis connection on graceful shutdown (SIGINT/SIGTERM via
 * `enableShutdownHooks`, or `app.close()`), so the process can exit cleanly
 * instead of the open socket keeping the event loop alive.
 */
@Injectable()
export class RedisLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
      this.logger.log('Redis connection closed.');
    } catch {
      // Best-effort — ignore errors while shutting down.
    }
  }
}
