import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { handleFetch } from '../src/recovery.js';
import { readState, writeActive, writeKilled } from '../src/state.js';
import type { AppConfig, Env } from '../src/types.js';
import { CONFIG } from '../src/config.js';

const cfg: AppConfig = { ...CONFIG, enableRecoveryWebhook: true };
const cfgDisabled: AppConfig = { ...CONFIG, enableRecoveryWebhook: false };

const SECRET = 'test-recovery-secret';

function makeRequest(method: string, path: string, token?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(`http://worker${path}`, { method, headers });
}

// No RESTORE_RATE_LIMITER binding: exercises the in-memory fallback limiter.
const envNoBinding = { ...env, RESTORE_RATE_LIMITER: undefined } as unknown as Env;

function fromIp(ip: string, token: string): Request {
  return new Request('http://worker/restore', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip },
  });
}

describe('handleFetch', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 }),
        ),
    );
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
    const body = (await res.json()) as { restored: boolean; previousReason: string };
    expect(body.restored).toBe(true);
    expect(body.previousReason).toBe('test');
  });

  it('is idempotent when already active', async () => {
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: boolean };
    expect(body.restored).toBe(true);
  });

  it('returns 429 with Retry-After after 10 requests from one client (fallback limiter)', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 10; i++) {
      const r = await handleFetch(fromIp(ip, 'wrong-secret'), envNoBinding, cfg);
      expect(r.status).toBe(403);
    }
    const blocked = await handleFetch(fromIp(ip, 'wrong-secret'), envNoBinding, cfg);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');

    // Requests are counted before auth, so a correct secret is throttled too
    // until the 60s window passes.
    const withSecret = await handleFetch(fromIp(ip, SECRET), envNoBinding, cfg);
    expect(withSecret.status).toBe(429);
  });

  it('fallback limiter window expires after 60s', async () => {
    vi.useFakeTimers();
    try {
      const ip = '10.0.0.2';
      for (let i = 0; i < 10; i++) await handleFetch(fromIp(ip, 'wrong'), envNoBinding, cfg);
      expect((await handleFetch(fromIp(ip, 'wrong'), envNoBinding, cfg)).status).toBe(429);
      vi.advanceTimersByTime(60_001);
      expect((await handleFetch(fromIp(ip, 'wrong'), envNoBinding, cfg)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fallback limiter logs the missing binding only once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handleFetch(fromIp('10.0.0.3', 'wrong'), envNoBinding, cfg);
      await handleFetch(fromIp('10.0.0.3', 'wrong'), envNoBinding, cfg);
      const missing = warn.mock.calls.filter(([m]) => String(m).includes('RESTORE_RATE_LIMITER'));
      expect(missing.length).toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the rate limit binding when present and returns 429 when it denies', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const envLimited = { ...env, RESTORE_RATE_LIMITER: { limit } } as unknown as Env;
    const res = await handleFetch(fromIp('10.0.0.4', SECRET), envLimited, cfg);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(limit).toHaveBeenCalledWith({ key: '10.0.0.4' });
  });

  it('proceeds to auth when the binding allows the request', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const envLimited = { ...env, RESTORE_RATE_LIMITER: { limit } } as unknown as Env;
    expect((await handleFetch(fromIp('10.0.0.5', 'wrong'), envLimited, cfg)).status).toBe(403);
    expect((await handleFetch(fromIp('10.0.0.5', SECRET), envLimited, cfg)).status).toBe(200);
  });

  /** The WAF rule exempts /restore so it stays reachable during a kill. Free-tier
   *  KV allows 1,000 writes/day — a metric this Worker monitors — so rate limiting
   *  must never touch KV, or unauthenticated traffic could trigger the kill. */
  it('never writes to KV for rate limiting, with or without the binding', async () => {
    const putSpy = vi.spyOn(env.KILL_SWITCH_STATE, 'put');
    const limit = vi.fn().mockResolvedValue({ success: true });
    const envLimited = { ...env, RESTORE_RATE_LIMITER: { limit } } as unknown as Env;
    try {
      for (let i = 0; i < 15; i++) {
        await handleFetch(fromIp('10.0.0.6', 'nope'), envNoBinding, cfg);
        await handleFetch(fromIp('10.0.0.7', 'nope'), envLimited, cfg);
      }
      expect(putSpy).not.toHaveBeenCalled();
      const keys = await env.KILL_SWITCH_STATE.list({ prefix: 'restore-attempts' });
      expect(keys.keys).toHaveLength(0);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('returns 500 when RECOVERY_SECRET is not configured — "Bearer undefined" must not authenticate', async () => {
    const envNoSecret = { ...env, RECOVERY_SECRET: undefined as unknown as string };
    const res = await handleFetch(makeRequest('POST', '/restore', 'undefined'), envNoSecret, cfg);
    expect(res.status).toBe(500);
  });

  it('rejects requests where Authorization header has wrong length', async () => {
    const res = await handleFetch(makeRequest('POST', '/restore', SECRET + 'x'), env, cfg);
    expect(res.status).toBe(403);
  });

  it('rate-limits per client IP — one IP cannot lock out another', async () => {
    for (let i = 0; i < 10; i++) {
      await handleFetch(fromIp('1.2.3.4', 'wrong'), envNoBinding, cfg);
    }
    expect((await handleFetch(fromIp('1.2.3.4', 'wrong'), envNoBinding, cfg)).status).toBe(429);
    // The operator, on a different IP, can still recover during the attack.
    expect((await handleFetch(fromIp('5.6.7.8', SECRET), envNoBinding, cfg)).status).toBe(200);
  });

  it('returns 502 and keeps a killed remnant when part of the restore fails', async () => {
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
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 9999, message: 'boom' }] }),
          { status: 500 },
        );
      }
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), {
        status: 200,
      });
    });

    const res = await handleFetch(makeRequest('POST', '/restore', SECRET), env, cfg);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { restored: boolean; errors: string[] };
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
