// Cloudflare's API occasionally returns 502/503/504 under load, and 429 when
// rate limited.  These are safe to retry for idempotent operations.  This
// helper wraps fetch with a short, bounded retry on transient server errors,
// rate limits and network failures (including per-attempt timeouts).

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

// A hung request would otherwise stall the whole cron tick.
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

// The Worker runs on a 5-minute cron on the Free plan; never sleep long for a
// Retry-After. Anything above this is returned to the caller's error path.
export const MAX_RETRY_AFTER_MS = 2_000;

export async function fetchRetry(
  input: string | URL,
  init?: RequestInit,
  maxAttempts = 2,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const res = await fetch(input, { ...init, signal });
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts) {
        let delay = 200 * attempt;
        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'));
          if (retryAfterMs !== undefined) {
            if (retryAfterMs > MAX_RETRY_AFTER_MS) return res;
            delay = retryAfterMs;
          }
        }
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      // The caller cancelled; retrying would ignore their intent.
      if (init?.signal?.aborted) throw err;
      if (attempt < maxAttempts) {
        await sleep(200 * attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
