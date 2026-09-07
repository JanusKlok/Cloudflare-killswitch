import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleFetch } from '../src/recovery.js';
import { readState, writeActive, writeKilled } from '../src/state.js';
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

  it('returns 429 after 10 failed authentications', async () => {
    // Reset the rolling window — prior tests in this file may have used some attempts.
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');

    for (let i = 0; i < 10; i++) {
      const r = await handleFetch(makeRequest('POST', '/restore', 'wrong-secret'), env, cfg);
      expect(r.status).toBe(403);
    }
    const blocked = await handleFetch(makeRequest('POST', '/restore', 'wrong-secret'), env, cfg);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');

    // The window is on failures, so a correct secret is still throttled while
    // it is open — the operator is not locked out beyond the 60s window.
    const withSecret = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(withSecret.status).toBe(429);
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
  });

  /** The WAF rule exempts /restore so it stays reachable during a kill, and the
   *  rate limiter used to write to KV on every request. Free-tier KV allows
   *  1,000 writes/day — a metric this Worker monitors — so unauthenticated
   *  traffic could trigger the very kill it is meant to guard against. */
  it('does not write to KV for a successful restore', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
    const putSpy = vi.spyOn(env.KILL_SWITCH_STATE, 'put');
    try {
      const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
      expect(res.status).toBe(200);
      const rateLimitWrites = putSpy.mock.calls.filter(([key]) => String(key).startsWith('restore-attempts'));
      expect(rateLimitWrites).toHaveLength(0);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('does not write to KV for an unauthenticated request beyond the failure cap', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
    for (let i = 0; i < 10; i++) {
      await handleFetch(makeRequest('POST', '/restore', 'nope'), env, cfg);
    }

    const putSpy = vi.spyOn(env.KILL_SWITCH_STATE, 'put');
    try {
      // Already at the cap: further requests are rejected by a read-only check,
      // so an attacker cannot keep spending KV writes.
      for (let i = 0; i < 5; i++) {
        const res = await handleFetch(makeRequest('POST', '/restore', 'nope'), env, cfg);
        expect(res.status).toBe(429);
      }
      expect(putSpy).not.toHaveBeenCalled();
    } finally {
      putSpy.mockRestore();
    }
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
  });

  it('returns 500 when RECOVERY_SECRET is not configured — "Bearer undefined" must not authenticate', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
    const envNoSecret = { ...env, RECOVERY_SECRET: undefined as unknown as string };
    const res = await handleFetch(makeRequest('POST', '/restore', 'undefined'), envNoSecret, cfg);
    expect(res.status).toBe(500);
  });

  it('rejects requests where Authorization header has wrong length', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET + 'x'), env, cfg);
    expect(res.status).toBe(403);
  });

  it('rate-limits per client IP — one IP cannot lock out another', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts:1.2.3.4');
    await env.KILL_SWITCH_STATE.delete('restore-attempts:5.6.7.8');

    const fromIp = (ip: string, token: string) =>
      new Request('http://worker/restore', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip },
      });

    for (let i = 0; i < 10; i++) {
      await handleFetch(fromIp('1.2.3.4', 'wrong'), env, cfg);
    }
    expect((await handleFetch(fromIp('1.2.3.4', 'wrong'), env, cfg)).status).toBe(429);
    // The operator, on a different IP, can still recover during the attack.
    expect((await handleFetch(fromIp('5.6.7.8', SECRET), env, cfg)).status).toBe(200);
  });

  it('returns 502 and keeps a killed remnant when part of the restore fails', async () => {
    await env.KILL_SWITCH_STATE.delete('restore-attempts:unknown');
    await writeKilled(env, {
      reason: 'test',
      wafRuleId: 'r-1',
      wafRulesetId: 'rs-1',
      disabledWorkerScripts: ['stuck-worker'],
    });

    // WAF rule deletion succeeds; the workers subdomain re-enable fails.
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/subdomain')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 9999, message: 'boom' }] }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
    });

    const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(res.status).toBe(502);
    const body = await res.json() as { restored: boolean; errors: string[] };
    expect(body.restored).toBe(false);
    expect(body.errors.join(' ')).toContain('stuck-worker');

    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.disabledWorkerScripts).toEqual(['stuck-worker']);
    expect(state.wafRuleId).toBeUndefined(); // WAF removal succeeded — cleared

    // Reset for any later tests.
    await writeActive(env);
  });
});
