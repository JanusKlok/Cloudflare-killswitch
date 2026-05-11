import type { AppConfig, Env } from './types.js';
import { readState, writeActive } from './state.js';
import { removeBlockRule } from './actions/waf.js';
import { enableWorkers } from './actions/block-workers.js';
import { restorePages } from './actions/block-pages.js';

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
 *  eventually consistent (~60 s), so this is a soft cap, not a hard one. */
async function checkAndRecordAttempt(env: Env): Promise<boolean> {
  const raw = await env.KILL_SWITCH_STATE.get(RATE_LIMIT_KEY);
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
  await env.KILL_SWITCH_STATE.put(RATE_LIMIT_KEY, JSON.stringify(attempts));
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

  if (!(await checkAndRecordAttempt(env))) {
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
    // Restore in reverse kill order; run all three concurrently — they touch
    // independent resources, so a Pages failure shouldn't delay WAF removal.
    await Promise.allSettled([
      state.blockedPagesProjects?.length
        ? restorePages(env, state.blockedPagesProjects).catch((err: unknown) =>
            console.error('restore-pages error:', err),
          )
        : Promise.resolve(),
      state.disabledWorkerScripts?.length
        ? enableWorkers(env, state.disabledWorkerScripts).catch((err: unknown) =>
            console.error('enable-workers error:', err),
          )
        : Promise.resolve(),
      state.wafRuleId && state.wafRulesetId
        ? removeBlockRule(env, cfg, state.wafRuleId, state.wafRulesetId)
        : Promise.resolve(),
    ]);
  }

  await writeActive(env);

  return new Response(JSON.stringify({ restored: true, previousReason }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
