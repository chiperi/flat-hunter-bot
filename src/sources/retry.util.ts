/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
}

/**
 * Run `fn`, retrying on throw with exponential backoff + full jitter. Jitter
 * spreads retries so many sources/profiles don't hammer a host in lockstep
 * after a shared outage.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 10_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === opts.retries) break;
      const exp = Math.min(max, base * 2 ** attempt);
      const waitMs = Math.round(exp / 2 + Math.random() * (exp / 2));
      opts.onRetry?.(attempt + 1, err, waitMs);
      await sleep(waitMs);
    }
  }

  throw lastError;
}
