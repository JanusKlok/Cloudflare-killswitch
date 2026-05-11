// Cloudflare's API occasionally returns 502/503/504 under load.  These are
// safe to retry for idempotent operations.  This helper wraps fetch with a
// short, bounded retry on transient server errors and network failures.

const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export async function fetchRetry(
  input: string | URL,
  init?: RequestInit,
  maxAttempts = 2,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(input, init);
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts) {
        await sleep(200 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await sleep(200 * attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
