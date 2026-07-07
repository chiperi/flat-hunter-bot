/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries: number;
  /** Base delay for the first retry; grows exponentially. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff wait. */
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
}

/**
 * Run `fn`, retrying on throw with exponential backoff + full jitter.
 * Jitter (a random fraction of the computed delay) spreads retries out so
 * many profiles don't hammer OLX in lockstep after a shared outage.
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
      const waitMs = Math.round(exp / 2 + Math.random() * (exp / 2)); // full jitter
      opts.onRetry?.(attempt + 1, err, waitMs);
      await sleep(waitMs);
    }
  }

  throw lastError;
}
