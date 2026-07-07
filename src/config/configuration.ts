/**
 * Central, typed view of the environment. Every module reads config through
 * `ConfigService<AppConfig, true>` rather than touching `process.env` directly,
 * so parsing/defaults live in exactly one place.
 */

export type ScraperKind = 'mock' | 'http';

export interface TelegramConfig {
  botToken: string;
  allowedUserIds: number[];
}

export interface RedisConfig {
  url: string;
  keyPrefix: string;
}

export interface PollingConfig {
  intervalMs: number;
  jitterMs: number;
}

export interface ScraperConfig {
  kind: ScraperKind;
  baseUrl: string;
  categoryPath: string;
  proxyUrl?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface AppConfig {
  telegram: TelegramConfig;
  redis: RedisConfig;
  polling: PollingConfig;
  scraper: ScraperConfig;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseUserIds(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

export default (): AppConfig => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required but was not provided.');
  }

  const kind = (process.env.SCRAPER?.trim() as ScraperKind) || 'mock';
  if (kind !== 'mock' && kind !== 'http') {
    throw new Error(`SCRAPER must be "mock" or "http", got "${kind}".`);
  }

  return {
    telegram: {
      botToken,
      allowedUserIds: parseUserIds(process.env.ALLOWED_USER_IDS),
    },
    redis: {
      url: process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379',
      keyPrefix: process.env.REDIS_KEY_PREFIX?.trim() || 'olx',
    },
    polling: {
      intervalMs: parseIntEnv(process.env.POLL_INTERVAL_MS, 5 * 60 * 1000),
      jitterMs: parseIntEnv(process.env.POLL_JITTER_MS, 60 * 1000),
    },
    scraper: {
      kind,
      baseUrl: process.env.OLX_BASE_URL?.trim() || 'https://www.olx.ua',
      categoryPath: process.env.OLX_CATEGORY_PATH?.trim() || 'uk/nedvizhimost/kvartiry',
      proxyUrl: process.env.HTTP_PROXY_URL?.trim() || undefined,
      timeoutMs: parseIntEnv(process.env.SCRAPER_TIMEOUT_MS, 15000),
      maxRetries: parseIntEnv(process.env.SCRAPER_MAX_RETRIES, 3),
    },
  };
};
