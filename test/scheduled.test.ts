import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runScheduled } from '../src/scheduled.js';
import { readState, writeActive, writeKilled } from '../src/state.js';
import type { AppConfig } from '../src/types.js';
import { CONFIG } from '../src/config.js';

// Config with very low limits so we can breach them easily in tests
const LOW_CFG: AppConfig = {
  ...CONFIG,
  scope: 'zone',
  enableRecoveryWebhook: true,
  limits: {
    ...CONFIG.limits,
    workers: { requests: { blockAt: 1 } },
    pages: { requests: { blockAt: 1_000_000 } },
    kv: { reads: { blockAt: 1_000_000 }, writes: { blockAt: 1_000_000 }, storageBytes: { blockAt: 1_000_000_000_000 } },
    r2: { storageBytes: { blockAt: 1_000_000_000_000 }, classAOps: { blockAt: 1_000_000_000 }, classBOps: { blockAt: 1_000_000_000 } },
    d1: { rowReads: { blockAt: 1_000_000_000 }, rowWrites: { blockAt: 1_000_000_000 }, storageBytes: { blockAt: 1_000_000_000_000 } },
  },
};

// Config where workers.requests triggers purge
const PURGE_CFG: AppConfig = {
  ...LOW_CFG,
  limits: {
    ...LOW_CFG.limits,
    workers: { requests: { blockAt: 1, purgeAt: 1 } },
  },
  purgeConfig: { r2: [], d1: [] },
};

// Fresh Response factory — avoids "body already used" when a mock is invoked
// more than once with the same Response object.
function jsonResp(body: unknown, status = 200) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function mockGraphqlResponse(requests: number) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [{ sum: { requests } }],
            pagesFunctionsInvocationsAdaptiveGroups: [],
            kvOperationsAdaptiveGroups: [],
            kvStorageAdaptiveGroups: [],
            r2OperationsAdaptiveGroups: [],
            r2StorageAdaptiveGroups: [],
            d1AnalyticsAdaptiveGroups: [],
            d1StorageAdaptiveGroups: [],
          },
        ],
      },
    },
  };
}

function wafResponse(rulesetId: string, ruleId: string) {
  return {
    success: true,
    errors: [],
    result: { id: rulesetId, phase: 'http_request_firewall_custom', rules: [{ id: ruleId }] },
  };
}

function routedMock(requests: number, rulesetId: string, ruleId: string) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('graphql')) return new Response(JSON.stringify(mockGraphqlResponse(requests)), { status: 200 });
    if (url.includes('rulesets/phases')) return new Response(JSON.stringify(wafResponse(rulesetId, 'rule-0')), { status: 200 });
    if (url.includes('/rules')) return new Response(JSON.stringify({ success: true, errors: [], result: { id: ruleId } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
  });
}

describe('runScheduled — no breach', () => {
  beforeEach(async () => { await writeActive(env); vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => vi.unstubAllGlobals());

  it('does not write killed state when all usage is zero', async () => {
    vi.mocked(fetch).mockImplementation(jsonResp(mockGraphqlResponse(0)));
    await runScheduled(env, LOW_CFG);
    expect((await readState(env)).status).toBe('active');
  });
});

describe('runScheduled — block breach (no purge)', () => {
  beforeEach(async () => { await writeActive(env); vi.stubGlobal('fetch', routedMock(100, 'rs-1', 'rule-new')); });
  afterEach(() => vi.unstubAllGlobals());

  it('deploys WAF, writes killed state, does NOT purge', async () => {
    await runScheduled(env, LOW_CFG);
    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.wafRuleId).toBe('rule-new');
    expect(state.wafRulesetId).toBe('rs-1');
    expect(state.reason).not.toContain('purge');
  });
});

describe('runScheduled — purge breach', () => {
  beforeEach(async () => { await writeActive(env); vi.stubGlobal('fetch', routedMock(999, 'rs-2', 'rule-purge')); });
  afterEach(() => vi.unstubAllGlobals());

  it('deploys WAF and writes killed state with purge in reason (purgeConfig empty = no actual purge)', async () => {
    await runScheduled(env, PURGE_CFG);
    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.reason).toContain('purge');
  });
});

describe('runScheduled — scope none (no zone on the account)', () => {
  beforeEach(async () => { await writeActive(env); vi.stubGlobal('fetch', routedMock(100, 'rs-x', 'rule-x')); });
  afterEach(() => vi.unstubAllGlobals());

  it('kills without any WAF call and still disables workers', async () => {
    const cfg: AppConfig = {
      ...LOW_CFG,
      scope: 'none',
      blocking: { ...LOW_CFG.blocking, workers: ['victim-worker'] },
    };
    await runScheduled(env, cfg);

    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.wafRuleId).toBeUndefined();
    expect(state.wafRulesetId).toBeUndefined();
    expect(state.disabledWorkerScripts).toEqual(['victim-worker']);

    const urls = vi.mocked(fetch).mock.calls.map(([input]) =>
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url,
    );
    expect(urls.some((u) => u.includes('rulesets'))).toBe(false);
  });
});

describe('runScheduled — already killed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when status is killed and no auto-reset', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await writeKilled(env, { reason: 'prior', wafRuleId: 'r', wafRulesetId: 'rs' });
    await runScheduled(env, { ...LOW_CFG, autoResetOnBillingCycle: false });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('runScheduled — kill durability', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The window between "actions performed" and "actions recorded" is the one
   *  place an isolate death leaves Workers dark and Pages serving 503 with
   *  nothing in state to undo them. Targets must therefore be persisted before
   *  the first mutating call. */
  it('records its targets before it mutates anything', async () => {
    const events: string[] = [];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('graphql')) {
        return new Response(JSON.stringify(mockGraphqlResponse(500)), { status: 200 });
      }
      if (url.includes('/subdomain')) {
        events.push('mutate:subdomain');
        return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
      }
      if (url.includes('/deployments') && init?.method === 'POST') {
        events.push('mutate:pages-deploy');
        return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
      }
      if (url.includes('/pages/projects/')) {
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: { canonical_deployment: { id: 'prev-1' }, production_branch: 'main' },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
    }));

    const originalPut = env.KILL_SWITCH_STATE.put.bind(env.KILL_SWITCH_STATE);
    const putSpy = vi
      .spyOn(env.KILL_SWITCH_STATE, 'put')
      .mockImplementation(async (key: string, value: Parameters<KVNamespace['put']>[1]) => {
        if (key === 'state' && typeof value === 'string') {
          const parsed = JSON.parse(value) as {
            disabledWorkerScripts?: string[];
            blockedPagesProjects?: { project: string }[];
          };
          if (parsed.disabledWorkerScripts?.length || parsed.blockedPagesProjects?.length) {
            events.push('record:targets');
          } else {
            events.push('record:waf');
          }
        }
        return originalPut(key, value);
      });

    try {
      await writeActive(env);
      events.length = 0;
      await runScheduled(env, {
        ...LOW_CFG,
        scope: 'none',
        blocking: { ...LOW_CFG.blocking, workers: ['victim'], pages: ['victim-pages'] },
      });
    } finally {
      putSpy.mockRestore();
    }

    const firstRecord = events.indexOf('record:targets');
    const firstMutation = events.findIndex((e) => e.startsWith('mutate:'));
    expect(firstRecord).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThanOrEqual(0);
    expect(firstRecord).toBeLessThan(firstMutation);

    const state = await readState(env);
    expect(state.disabledWorkerScripts).toEqual(['victim']);
    expect(state.blockedPagesProjects).toEqual([
      { project: 'victim-pages', previousDeploymentId: 'prev-1' },
    ]);
    await writeActive(env);
  });

  it('keeps a target recorded even when blocking it fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('graphql')) {
        return new Response(JSON.stringify(mockGraphqlResponse(500)), { status: 200 });
      }
      if (url.includes('/subdomain')) {
        // The disable fails, but the script may still have been disabled before
        // the response was lost — dropping it from state would leave it dark.
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'boom' }] }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
    }));

    await writeActive(env);
    await runScheduled(env, {
      ...LOW_CFG,
      scope: 'none',
      blocking: { ...LOW_CFG.blocking, workers: ['stubborn'], pages: [] },
    });

    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.disabledWorkerScripts).toEqual(['stubborn']);
    await writeActive(env);
  });

  it('still kills via workers/pages when the WAF deploy fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('graphql')) {
        return new Response(JSON.stringify(mockGraphqlResponse(500)), { status: 200 });
      }
      if (url.includes('rulesets')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
      }
      return new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 });
    }));

    await writeActive(env);
    await runScheduled(env, {
      ...LOW_CFG,
      scope: 'zone',
      blocking: { ...LOW_CFG.blocking, workers: ['victim'], pages: [] },
    });

    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.wafRuleId).toBeUndefined();
    // The independent mitigation must not be skipped just because WAF failed.
    expect(state.disabledWorkerScripts).toEqual(['victim']);
    await writeActive(env);
  });
});
