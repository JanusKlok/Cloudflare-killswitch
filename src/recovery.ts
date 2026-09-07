import type { AppConfig, Env } from './types.js';
import { readState, writeActive } from './state.js';
import { restoreFromState } from './restore.js';

const RATE_LIMIT_KEY = 'restore-attempts';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ATTEMPTS = 10;

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
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

function rateLimitKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return `${RATE_LIMIT_KEY}:${ip}`;
}

function parseAttempts(raw: string | null, now: number): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number' && now - n < RATE_WINDOW_MS);
  } catch {
    return []; // malformed state — start fresh
  }
}

/** Read-only check of the rolling per-IP window.
 *
 *  Split from recording deliberately.  This used to write to KV on *every*
 *  request, including unauthenticated ones — and because the WAF rule exempts
 *  /restore so it stays reachable during a kill, an attacker could spend the
 *  free tier's 1,000 KV writes/day, which is a metric this very Worker monitors.
 *  Unauthenticated traffic could therefore trigger the kill it is meant to
 *  guard.  Writes now happen only after a failed authentication (below), so a
 *  single IP can cost at most RATE_MAX_ATTEMPTS writes per window.
 *
 *  KV reads are eventually consistent (~60 s), so this is a soft cap. The
 *  32-byte RECOVERY_SECRET remains the primary brute-force defense. Keyed per
 *  client IP: a global budget would let an attacker lock the real operator out
 *  of recovery during an incident. */
async function isRateLimited(env: Env, request: Request): Promise<boolean> {
  const raw = await env.KILL_SWITCH_STATE.get(rateLimitKey(request));
  return parseAttempts(raw, Date.now()).length >= RATE_MAX_ATTEMPTS;
}

/** Records one failed authentication against the client's rolling window. */
async function recordFailedAttempt(env: Env, request: Request): Promise<void> {
  const key = rateLimitKey(request);
  const now = Date.now();
  const attempts = parseAttempts(await env.KILL_SWITCH_STATE.get(key), now);
  attempts.push(now);
  // TTL keeps per-IP keys from accumulating in KV (60 is the KV minimum).
  await env.KILL_SWITCH_STATE.put(key, JSON.stringify(attempts), { expirationTtl: 120 });
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
    return jsonResponse({ error: 'Recovery secret not configured' }, 500);
  }

  if (await isRateLimited(env, request)) {
    return jsonResponse({ error: 'Too Many Requests' }, 429, { 'Retry-After': '60' });
  }

  const auth = request.headers.get('Authorization') ?? '';
  if (!timingSafeEqual(auth, `Bearer ${env.RECOVERY_SECRET}`)) {
    await recordFailedAttempt(env, request);
    return jsonResponse({ error: 'Unauthorized' }, 403);
  }

  const state = await readState(env);
  const previousReason = state.reason;

  if (state.status === 'killed') {
    const { fullyRestored, errors } = await restoreFromState(env, cfg, state);
    if (!fullyRestored) {
      console.error('partial restore failure:', errors.join('; '));
      return jsonResponse({ restored: false, previousReason, errors }, 502);
    }
  } else {
    await writeActive(env);
  }

  return jsonResponse({ restored: true, previousReason }, 200);
}
