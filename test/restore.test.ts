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
    expect(result).toEqual({ fullyRestored: true, errors: [] });
    expect((await readState(env)).status).toBe('active');
  });

  it('fully restores a scope-none kill that only disabled Workers', async () => {
    const result = await restoreFromState(
      env,
      noneCfg,
      killed({ disabledWorkerScripts: ['victim'] }),
    );
    expect(result.fullyRestored).toBe(true);
    expect((await readState(env)).status).toBe('active');

    const enabled = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => urlOf(input).includes('/subdomain'));
    expect(enabled).toHaveLength(1);
    const body = enabled[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON string request body');
    expect(JSON.parse(body)).toEqual({ enabled: true });
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
      killed({ killedAt: original, timestamp: original, disabledWorkerScripts: ['stuck'] }),
    );

    expect(result.fullyRestored).toBe(false);
    const state = await readState(env);
    expect(state.status).toBe('killed');
    // Restamping this would push the auto-reset anchor into the current billing
    // period and suppress every further attempt until the next one.
    expect(state.killedAt).toBe(original);
    expect(state.timestamp).not.toBe(original);
    expect(state.disabledWorkerScripts).toEqual(['stuck']);
  });

  it('reports an incomplete WAF reference rather than claiming success', async () => {
    // Only reachable from a hand-edited KV value, but silently reporting a full
    // restore would leave the rule live and blocking all traffic.
    const result = await restoreFromState(env, zoneCfg, killed({ wafRuleId: 'orphan' }));
    expect(result.fullyRestored).toBe(false);
    expect(result.errors.join(' ')).toContain('incomplete reference');
  });
});
