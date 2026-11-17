import type { AppConfig, Env } from './types.js';
import { readState, writeActive } from './state.js';
import { restoreFromState } from './restore.js';
import { sendAlerts } from './alerts.js';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ATTEMPTS = 10;
// Bounds fallback memory when an attacker rotates IPs; oldest entries go first.
const FALLBACK_MAX_KEYS = 5_000;

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Constant-time string comparison.  Length leak is acceptable here: the secret
 *  length is fixed by the operator and not derived from any per-request input. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

const fallbackHits = new Map<string, number[]>();
let warnedMissingBinding = false;

/** Per-isolate sliding window used when the RESTORE_RATE_LIMITER binding is
 *  absent.  Weaker than the binding (isolates do not share it) but it costs no
 *  KV writes and keeps the 10-per-60s shape. */
function fallbackLimited(ip: string, now: number): boolean {
  if (!warnedMissingBinding) {
    warnedMissingBinding = true;
    console.warn(
      'RESTORE_RATE_LIMITER binding is missing — using a per-isolate in-memory limiter for /restore. ' +
        'Add the [[ratelimits]] block from wrangler.toml.example for a limit shared across isolates.',
    );
  }
  const recent = (fallbackHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_ATTEMPTS) {
    fallbackHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  fallbackHits.delete(ip); // re-insert so Map order tracks recency
  fallbackHits.set(ip, recent);

  if (fallbackHits.size > FALLBACK_MAX_KEYS) {
    for (const [key, hits] of fallbackHits) {
      if (hits.every((t) => now - t >= RATE_WINDOW_MS)) fallbackHits.delete(key);
    }
    while (fallbackHits.size > FALLBACK_MAX_KEYS) {
      const oldest = fallbackHits.keys().next().value;
      if (oldest === undefined) break;
      fallbackHits.delete(oldest);
    }
  }
  return false;
}

/** Per-client-IP rate limit on POST /restore, checked before authentication.
 *
 *  Uses the Workers Rate Limiting binding, which keeps its counters outside KV.
 *  The previous KV-backed limiter wrote on every failed auth, and because the
 *  WAF rule exempts /restore so it stays reachable during a kill, an attacker
 *  rotating IPs could burn the free tier's 1,000 KV writes/day — a metric this
 *  Worker monitors — and so trigger a kill with unauthenticated traffic.
 *
 *  Every request is counted, not just failed auths: the binding is free of KV
 *  writes, and counting all requests also caps authenticated retries.  Counts
 *  are per Cloudflare location and eventually consistent, so this is a soft
 *  cap; the 32-byte RECOVERY_SECRET remains the primary brute-force defense.
 *  Keyed per IP: a global budget would let an attacker lock the operator out. */
async function isRateLimited(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (env.RESTORE_RATE_LIMITER) {
    const { success } = await env.RESTORE_RATE_LIMITER.limit({ key: ip });
    return !success;
  }
  return fallbackLimited(ip, Date.now());
}

export async function handleFetch(request: Request, env: Env, cfg: AppConfig): Promise<Response> {
  if (!cfg.enableRecoveryWebhook) return new Response(null, { status: 404 });
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/restore') {
    return new Response(null, { status: 404 });
  }

  // Fail closed if the secret was never set: env.RECOVERY_SECRET is typed as
  // string but is undefined at runtime until `wrangler secret put` — without
  // this guard the literal string "Bearer undefined" would authenticate.
  if (!env.RECOVERY_SECRET) {
    console.error('RECOVERY_SECRET is not set — refusing /restore');
    return jsonResponse({ error: 'Recovery secret not configured' }, 500);
  }

  if (await isRateLimited(env, request)) {
    return jsonResponse({ error: 'Too Many Requests' }, 429, { 'Retry-After': '60' });
  }

  const auth = request.headers.get('Authorization') ?? '';
  if (!timingSafeEqual(auth, `Bearer ${env.RECOVERY_SECRET}`)) {
    return jsonResponse({ error: 'Unauthorized' }, 403);
  }

  const state = await readState(env);
  const previousReason = state.reason;

  if (state.status === 'killed') {
    const { fullyRestored, errors, notes } = await restoreFromState(env, cfg, state);
    if (!fullyRestored) {
      console.error('partial restore failure:', errors.join('; '));
      return jsonResponse({ restored: false, previousReason, errors, notes }, 502);
    }
    await sendAlerts(
      env,
      '[Kill Switch] Restored via /restore',
      ['Traffic restored by POST /restore.', ...notes].join('\n'),
    );
    return jsonResponse({ restored: true, previousReason, notes }, 200);
  } else {
    await writeActive(env);
  }

  return jsonResponse({ restored: true, previousReason }, 200);
}
