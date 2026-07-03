import type { AppConfig, Env } from './types.js';
import { readState, writeActive } from './state.js';
import { restoreFromState } from './restore.js';

const RATE_LIMIT_KEY = 'restore-attempts';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ATTEMPTS = 10;

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

/** Rolling-window rate limit on /restore.  Defense-in-depth — the 32-byte
 *  RECOVERY_SECRET is the primary brute-force defense.  KV reads are
 *  eventually consistent (~60 s), so this is a soft cap, not a hard one.
 *  Keyed per client IP: /restore is exempt from the WAF block, so a global
 *  budget would let an attacker spam requests and lock the real operator
 *  out of recovery during an incident. */
async function checkAndRecordAttempt(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const key = `${RATE_LIMIT_KEY}:${ip}`;
  const raw = await env.KILL_SWITCH_STATE.get(key);
  const now = Date.now();
  let attempts: number[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) attempts = parsed.filter((n) => typeof n === 'number');
    } catch {
      // ignore malformed state — start fresh
    }
  }
  attempts = attempts.filter((t) => now - t < RATE_WINDOW_MS);
  if (attempts.length >= RATE_MAX_ATTEMPTS) return false;
  attempts.push(now);
  // TTL keeps per-IP keys from accumulating in KV (60 is the KV minimum).
  await env.KILL_SWITCH_STATE.put(key, JSON.stringify(attempts), { expirationTtl: 120 });
  return true;
}

export async function handleFetch(
  request: Request,
  env: Env,
  cfg: AppConfig,
): Promise<Response> {
  if (!cfg.enableRecoveryWebhook) return new Response(null, { status: 404 });
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/restore') {
    return new Response(null, { status: 404 });
  }

  // Fail closed if the secret was never set: env.RECOVERY_SECRET is typed as
  // string but is undefined at runtime until `wrangler secret put` — without
  // this guard the literal string "Bearer undefined" would authenticate.
  if (!env.RECOVERY_SECRET) {
    console.error('RECOVERY_SECRET is not set — refusing /restore');
    return new Response(JSON.stringify({ error: 'Recovery secret not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!(await checkAndRecordAttempt(env, request))) {
    return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }

  const auth = request.headers.get('Authorization') ?? '';
  if (!timingSafeEqual(auth, `Bearer ${env.RECOVERY_SECRET}`)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const state = await readState(env);
  const previousReason = state.reason;

  if (state.status === 'killed') {
    const { fullyRestored, errors } = await restoreFromState(env, cfg, state);
    if (!fullyRestored) {
      console.error('partial restore failure:', errors.join('; '));
      return new Response(JSON.stringify({ restored: false, previousReason, errors }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } else {
    await writeActive(env);
  }

  return new Response(JSON.stringify({ restored: true, previousReason }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
