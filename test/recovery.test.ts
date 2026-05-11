import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleFetch } from '../src/recovery.js';
import { writeKilled } from '../src/state.js';
import type { AppConfig } from '../src/types.js';
import { CONFIG } from '../src/config.js';

const cfg: AppConfig = { ...CONFIG, enableRecoveryWebhook: true };
const cfgDisabled: AppConfig = { ...CONFIG, enableRecoveryWebhook: false };

const SECRET = 'test-recovery-secret';

function makeRequest(method: string, path: string, token?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(`http://worker${path}`, { method, headers });
}

describe('handleFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 }),
    ));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns 404 when webhook is disabled', async () => {
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfgDisabled);
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-/restore paths', async () => {
    const res = await handleFetch(makeRequest('GET', '/health'), env, cfg);
    expect(res.status).toBe(404);
  });

  it('returns 403 with wrong secret', async () => {
    const res = await handleFetch(makeRequest('POST', '/restore', 'wrong-secret'), env, cfg);
    expect(res.status).toBe(403);
  });

  it('returns 403 with no auth header', async () => {
    const res = await handleFetch(makeRequest('POST', '/restore'), env, cfg);
    expect(res.status).toBe(403);
  });

  it('returns 200 and restores when killed', async () => {
    await writeKilled(env, { reason: 'test', wafRuleId: 'r-1', wafRulesetId: 'rs-1' });
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(res.status).toBe(200);
    const body = await res.json() as { restored: boolean; previousReason: string };
    expect(body.restored).toBe(true);
    expect(body.previousReason).toBe('test');
  });

  it('is idempotent when already active', async () => {
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(res.status).toBe(200);
    const body = await res.json() as { restored: boolean };
    expect(body.restored).toBe(true);
  });

  it('returns 429 after the rate limit is exceeded', async () => {
    // Reset the rolling window — prior tests in this file may have used some attempts.
    await env.KILL_SWITCH_STATE.delete('restore-attempts');

    // 10 successful attempts fill the window — all return 200 since the
    // secret is correct.  The 11th must be rate-limited.
    for (let i = 0; i < 10; i++) {
      const r = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
      expect(r.status).toBe(200);
    }
    const blocked = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
  });

  it('rejects requests where Authorization header has wrong length', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts');
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET + 'x'), env, cfg);
    expect(res.status).toBe(403);
  });
});
