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

describe('runScheduled — already killed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when status is killed and no auto-reset', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await writeKilled(env, { reason: 'prior', wafRuleId: 'r', wafRulesetId: 'rs' });
    await runScheduled(env, { ...LOW_CFG, autoResetOnFirstOfMonth: false });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
