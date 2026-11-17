import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { restoreFromState } from '../src/restore.js';
import { readState, writeActive } from '../src/state.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig, KvState } from '../src/types.js';
import { urlOf } from './helpers.js';

const zoneCfg: AppConfig = { ...CONFIG, scope: 'zone' };
const noneCfg: AppConfig = { ...CONFIG, scope: 'none' };

function killed(over: Partial<KvState> = {}): KvState {
  return {
    status: 'killed',
    timestamp: '2026-03-01T00:00:00Z',
    killedAt: '2026-03-01T00:00:00Z',
    reason: 'test',
    ...over,
  };
}

describe('restoreFromState', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 }),
        ),
    ),
  );
  afterEach(async () => {
    vi.unstubAllGlobals();
    await writeActive(env);
  });

  /** Every `scope: 'none'` account takes this path: nothing to undo on the WAF
   *  side. If it reported a partial failure, /restore would 502 forever and
   *  auto-reset would bail, leaving the account permanently killed. */
  it('fully restores a kill that recorded no WAF rule', async () => {
    const result = await restoreFromState(env, noneCfg, killed());
    expect(result).toEqual({ fullyRestored: true, errors: [], notes: [], changed: true });
    expect((await readState(env)).status).toBe('active');
  });

  it('fully restores a scope-none kill that only disabled Workers', async () => {
    const result = await restoreFromState(
      env,
      noneCfg,
      killed({
        disabledWorkerScripts: [{ script: 'victim', enabled: true, previewsEnabled: false }],
      }),
    );
    expect(result.fullyRestored).toBe(true);
    expect((await readState(env)).status).toBe('active');

    const enabled = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => urlOf(input).includes('/subdomain'));
    expect(enabled).toHaveLength(1);
    const body = enabled[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON string request body');
    expect(JSON.parse(body)).toEqual({ enabled: true, previews_enabled: false });
  });

  /** A kill written by v2.0.0 holds bare script names; it must restore exactly
   *  as v2.0.0 did, without touching preview URLs. */
  it('restores a legacy string-shaped state with enabled:true only', async () => {
    const result = await restoreFromState(
      env,
      noneCfg,
      killed({ disabledWorkerScripts: ['legacy-victim'] }),
    );
    expect(result.fullyRestored).toBe(true);

    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => urlOf(input).includes('/subdomain'));
    expect(calls).toHaveLength(1);
    expect(urlOf(calls[0]?.[0] ?? '')).toContain('/scripts/legacy-victim/subdomain');
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toEqual({ enabled: true });
  });

  it('makes no WAF call when no rule was recorded', async () => {
    await restoreFromState(env, noneCfg, killed({ disabledWorkerScripts: ['victim'] }));
    const wafCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => urlOf(input).includes('rulesets'));
    expect(wafCalls).toHaveLength(0);
  });

  it('removes a recorded WAF rule and clears the state', async () => {
    const result = await restoreFromState(
      env,
      zoneCfg,
      killed({ wafRuleId: 'r-1', wafRulesetId: 'rs-1' }),
    );
    expect(result.fullyRestored).toBe(true);

    const deletes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    const target = deletes[0]?.[0];
    expect(target).toBeDefined();
    expect(urlOf(target ?? '')).toContain('/rulesets/rs-1/rules/r-1');
  });

  it('preserves the original kill time across a partial failure', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/subdomain')) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 1, message: 'no' }] }),
          {
            status: 500,
          },
        );
      }
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), {
        status: 200,
      });
    });

    const original = '2026-02-14T09:00:00Z';
    const result = await restoreFromState(
      env,
      noneCfg,
      killed({
        killedAt: original,
        timestamp: original,
        disabledWorkerScripts: [
          { script: 'stuck', enabled: false, previewsEnabled: true },
          'legacy-stuck',
        ],
      }),
    );

    expect(result.fullyRestored).toBe(false);
    const state = await readState(env);
    expect(state.status).toBe('killed');
    // Restamping this would push the auto-reset anchor into the current billing
    // period and suppress every further attempt until the next one.
    expect(state.killedAt).toBe(original);
    expect(state.timestamp).not.toBe(original);
    // Failed entries keep their recorded values (and legacy ones their shape).
    expect(state.disabledWorkerScripts).toEqual([
      { script: 'stuck', enabled: false, previewsEnabled: true },
      'legacy-stuck',
    ]);
  });

  it('keeps resetWindow, purgedServices and only still-failing pending entries on partial failure', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const failing = urlOf(input).includes('/scripts/stuck/subdomain');
      return failing
        ? new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'no' }] }), {
            status: 500,
          })
        : new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
    });

    await restoreFromState(
      env,
      noneCfg,
      killed({
        resetWindow: 'day',
        purgedServices: ['d1'],
        disabledWorkerScripts: [
          { script: 'stuck', enabled: true, previewsEnabled: false },
          { script: 'fine', enabled: true, previewsEnabled: false },
        ],
        pendingWorkerBlocks: ['stuck', 'fine'],
        blockedPagesProjects: [
          { project: 'site', previousDeploymentId: 'orig', productionBranch: 'main' },
        ],
        pendingPagesBlocks: ['site'],
      }),
    );

    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.resetWindow).toBe('day');
    expect(state.purgedServices).toEqual(['d1']);
    expect(state.pendingWorkerBlocks).toEqual(['stuck']);
    expect(state.pendingPagesBlocks).toBeUndefined();
  });

  it('does not invent resetWindow or purgedServices for a v2.0.0 state', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'no' }] }), {
        status: 500,
      }),
    );
    await restoreFromState(env, noneCfg, killed({ disabledWorkerScripts: ['legacy'] }));
    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state).not.toHaveProperty('resetWindow');
    expect(state).not.toHaveProperty('purgedServices');
  });

  it('reports an incomplete WAF reference rather than claiming success', async () => {
    // Only reachable from a hand-edited KV value, but silently reporting a full
    // restore would leave the rule live and blocking all traffic.
    const result = await restoreFromState(env, zoneCfg, killed({ wafRuleId: 'orphan' }));
    expect(result.fullyRestored).toBe(false);
    expect(result.errors.join(' ')).toContain('incomplete reference');
  });
});
