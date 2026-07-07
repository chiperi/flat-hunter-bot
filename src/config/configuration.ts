import { KNOWN_SOURCE_IDS } from '../sources/listing.interface';

/**
 * Central, typed view of the environment. Every module reads config through
 * `ConfigService<AppConfig, true>` rather than touching `process.env` directly.
 */

export type SourceMode = 'mock' | 'http';

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

export interface SourcesConfig {
  /** mock = network-free fake data (default); http = real best-effort scraping. */
  mode: SourceMode;
  /** Which site sources are active. */
  enabled: string[];
  /** Shared HTTP knobs for all http-mode sources. */
  timeoutMs: number;
  maxRetries: number;
  proxyUrl?: string;
  /** Per-site settings. */
  olx: { baseUrl: string; categoryPath: string };
  domria: { baseUrl: string; apiKey?: string; maxDetails: number };
}

export interface AppConfig {
  telegram: TelegramConfig;
  redis: RedisConfig;
  polling: PollingConfig;
  sources: SourcesConfig;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseUserIds(value: string | undefined): number[] {
  return parseCsv(value)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

export default (): AppConfig => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required but was not provided.');
  }

  const mode = (process.env.SCRAPER?.trim() as SourceMode) || 'mock';
  if (mode !== 'mock' && mode !== 'http') {
    throw new Error(`SCRAPER must be "mock" or "http", got "${mode}".`);
  }

  // SOURCES=olx,domria,... — default: every known source. Unknown ids dropped.
  const requested = parseCsv(process.env.SOURCES);
  const known = new Set<string>(KNOWN_SOURCE_IDS);
  const enabled = (requested.length ? requested : [...KNOWN_SOURCE_IDS]).filter((id) =>
    known.has(id),
  );

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
    sources: {
      mode,
      enabled,
      timeoutMs: parseIntEnv(process.env.SCRAPER_TIMEOUT_MS, 15000),
      maxRetries: parseIntEnv(process.env.SCRAPER_MAX_RETRIES, 3),
      proxyUrl: process.env.HTTP_PROXY_URL?.trim() || undefined,
      olx: {
        baseUrl: process.env.OLX_BASE_URL?.trim() || 'https://www.olx.ua',
        categoryPath: process.env.OLX_CATEGORY_PATH?.trim() || 'uk/nedvizhimost/kvartiry',
      },
      domria: {
        baseUrl: process.env.DOMRIA_BASE_URL?.trim() || 'https://developers.ria.com',
        apiKey: process.env.DOMRIA_API_KEY?.trim() || undefined,
        // Cap the per-search detail fetches — DOM.RIA needs one extra API call
        // per listing, the single biggest request amplifier. Keep it modest to
        // stay well within the API quota.
        maxDetails: parseIntEnv(process.env.DOMRIA_MAX_DETAILS, 10),
      },
    },
  };
};
