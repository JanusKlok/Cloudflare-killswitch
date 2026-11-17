import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runScheduled } from '../src/scheduled.js';
import { restoreFromState } from '../src/restore.js';
import { readState, writeActive } from '../src/state.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig, KvState } from '../src/types.js';
import { urlOf } from './helpers.js';

const WAF_DESCRIPTION = 'Kill Switch — automated traffic block';

/** A tiny stateful Cloudflare: scripts and Pages projects keep the state the
 *  API calls put them in, so a re-read after the kill reports what the real API
 *  would (a disabled script reads enabled:false, a blocked project's current
 *  deployment is the empty kill deployment). */
interface World {
  workersRequests: number;
  r2ClassA: number;
  d1RowsRead: number;
  scripts: Map<string, { enabled: boolean; previews: boolean }>;
  pages: Map<string, { deploymentId: string; branch: string }>;
  failSubdomainPost: Set<string>;
  failPagesDeploy: Set<string>;
  wafRules: { id: string; description: string }[];
  wafDown: boolean;
  log: string[];
}

function newWorld(): World {
  return {
    workersRequests: 0,
    r2ClassA: 0,
    d1RowsRead: 0,
    scripts: new Map(),
    pages: new Map(),
    failSubdomainPost: new Set(),
    failPagesDeploy: new Set(),
    wafRules: [],
    wafDown: false,
    log: [],
  };
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const fail = (status: number) =>
  new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: 'boom' }] }), {
    status,
  });

function graphqlBody(w: World) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [{ sum: { requests: w.workersRequests } }],
            pagesFunctionsInvocationsAdaptiveGroups: [],
            kvOperationsAdaptiveGroups: [],
            kvStorageAdaptiveGroups: [],
            r2OperationsAdaptiveGroups:
              w.r2ClassA > 0
                ? [{ sum: { requests: w.r2ClassA }, dimensions: { actionType: 'PutObject' } }]
                : [],
            r2StorageAdaptiveGroups:
              w.r2ClassA > 0 ? [{ max: { payloadSize: 1 }, dimensions: { bucketName: 'b' } }] : [],
            d1AnalyticsAdaptiveGroups:
              w.d1RowsRead > 0 ? [{ sum: { rowsRead: w.d1RowsRead, rowsWritten: 0 } }] : [],
            d1StorageAdaptiveGroups:
              w.d1RowsRead > 0
                ? [{ max: { databaseSizeBytes: 1 }, dimensions: { databaseId: 'db' } }]
                : [],
          },
        ],
      },
    },
  };
}

function installWorld(w: World) {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    w.log.push(`${method} ${path}`);

    if (url.includes('graphql'))
      return new Response(JSON.stringify(graphqlBody(w)), { status: 200 });

    if (path.includes('/rulesets')) {
      if (w.wafDown) return fail(403);
      if (method === 'POST') {
        const rule = { id: `rule-${w.wafRules.length + 1}`, description: WAF_DESCRIPTION };
        w.wafRules.push(rule);
        return ok({ id: rule.id });
      }
      return ok({ id: 'rs-1', phase: 'http_request_firewall_custom', rules: w.wafRules });
    }

    const sub = /\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
    if (sub?.[1]) {
      const name = decodeURIComponent(sub[1]);
      const script = w.scripts.get(name);
      if (method === 'POST') {
        if (w.failSubdomainPost.has(name)) return fail(500);
        const body = JSON.parse(init?.body as string) as {
          enabled: boolean;
          previews_enabled?: boolean;
        };
        const target = script ?? { enabled: false, previews: false };
        target.enabled = body.enabled;
        if (body.previews_enabled !== undefined) target.previews = body.previews_enabled;
        w.scripts.set(name, target);
        return ok({});
      }
      if (!script) return fail(404);
      return ok({ enabled: script.enabled, previews_enabled: script.previews });
    }
    if (path.endsWith('/workers/scripts')) {
      return ok([...w.scripts.keys()].map((id) => ({ id })).concat([{ id: env.WORKER_SELF_NAME }]));
    }

    const rollback = /\/pages\/projects\/([^/]+)\/deployments\/([^/]+)\/rollback$/.exec(path);
    if (rollback?.[1] && rollback[2]) {
      const page = w.pages.get(decodeURIComponent(rollback[1]));
      if (page) page.deploymentId = decodeURIComponent(rollback[2]);
      return ok({});
    }
    const deploy = /\/pages\/projects\/([^/]+)\/deployments$/.exec(path);
    if (deploy?.[1] && method === 'POST') {
      const name = decodeURIComponent(deploy[1]);
      if (w.failPagesDeploy.has(name)) return fail(500);
      const page = w.pages.get(name);
      if (page) page.deploymentId = 'kill-switch-empty';
      return ok({ id: 'kill-switch-empty' });
    }
    const project = /\/pages\/projects\/([^/]+)$/.exec(path);
    if (project?.[1]) {
      const page = w.pages.get(decodeURIComponent(project[1]));
      if (!page) return fail(404);
      return ok({
        canonical_deployment: { id: page.deploymentId },
        production_branch: page.branch,
      });
    }
    if (path.endsWith('/pages/projects')) return ok([...w.pages.keys()].map((name) => ({ name })));

    return ok({});
  };
  vi.stubGlobal('fetch', vi.fn(handler));
}

const HUGE = 1_000_000_000_000;
const CFG: AppConfig = {
  ...CONFIG,
  scope: 'none',
  autoResetOnBillingCycle: true,
  billingCycleDay: 12,
  enableRecoveryWebhook: false,
  limits: {
    workers: { requests: { blockAt: 1 } },
    pages: { requests: { blockAt: HUGE } },
    kv: {
      reads: { blockAt: HUGE },
      writes: { blockAt: HUGE },
      deletes: { blockAt: HUGE },
      lists: { blockAt: HUGE },
      storageBytes: { blockAt: HUGE },
    },
    r2: {
      storageBytes: { blockAt: HUGE },
      classAOps: { blockAt: HUGE },
      classBOps: { blockAt: HUGE },
    },
    d1: {
      rowReads: { blockAt: HUGE },
      rowWrites: { blockAt: HUGE },
      storageBytes: { blockAt: HUGE },
    },
  },
  purgeConfig: { r2: [], d1: [] },
  blocking: { workers: 'all', pages: 'all' },
};

const withLimits = (
  limits: Partial<AppConfig['limits']>,
  over: Partial<AppConfig> = {},
): AppConfig => ({
  ...CFG,
  ...over,
  limits: { ...CFG.limits, ...limits },
});

let world: World;
let putSpy: {
  mock: { calls: unknown[][] };
  mockClear(): void;
  mockRestore(): void;
};

const stateWrites = () => putSpy.mock.calls.filter(([key]) => key === 'state').length;
/** Non-GraphQL writes: GraphQL itself is a POST. */
const mutations = (w: World) => w.log.filter((l) => l.startsWith('POST') && !l.includes('graphql'));
const killedState = (over: Partial<KvState>): KvState => ({
  status: 'killed',
  timestamp: '2026-03-10T12:00:00.000Z',
  killedAt: '2026-03-10T12:00:00.000Z',
  reason: 'test',
  ...over,
});
const putState = (s: KvState) => env.KILL_SWITCH_STATE.put('state', JSON.stringify(s));

beforeEach(async () => {
  await writeActive(env);
  world = newWorld();
  installWorld(world);
  putSpy = vi.spyOn(env.KILL_SWITCH_STATE, 'put');
});
afterEach(async () => {
  putSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await writeActive(env);
});

/** One account with a script and a Pages project, both live, plus a breach. */
function liveAccount() {
  world.scripts.set('app', { enabled: true, previews: true });
  world.pages.set('site', { deploymentId: 'orig-1', branch: 'main' });
  world.workersRequests = 500;
}

describe('killed tick — idempotence and restore safety', () => {
  it('two consecutive killed ticks then restore: restore still targets the ORIGINAL values', async () => {
    liveAccount();
    await runScheduled(env, CFG); // first kill
    expect(world.scripts.get('app')).toEqual({ enabled: false, previews: false });
    expect(world.pages.get('site')?.deploymentId).toBe('kill-switch-empty');

    await runScheduled(env, CFG); // killed tick 1
    await runScheduled(env, CFG); // killed tick 2

    const state = await readState(env);
    expect(state.disabledWorkerScripts).toEqual([
      { script: 'app', enabled: true, previewsEnabled: true },
    ]);
    expect(state.blockedPagesProjects).toEqual([
      { project: 'site', previousDeploymentId: 'orig-1', productionBranch: 'main' },
    ]);

    const result = await restoreFromState(env, CFG, state);
    expect(result.fullyRestored).toBe(true);
    expect(world.scripts.get('app')).toEqual({ enabled: true, previews: true });
    expect(world.pages.get('site')?.deploymentId).toBe('orig-1');
  });

  it('a quiet killed tick writes no KV and costs 3 subrequests (1 merged GraphQL + 2 list calls)', async () => {
    liveAccount();
    await runScheduled(env, CFG);
    putSpy.mockClear();
    world.log.length = 0;

    await runScheduled(env, CFG);

    expect(stateWrites()).toBe(0);
    expect(world.log).toHaveLength(3);
    expect(mutations(world)).toHaveLength(0);
    // Recorded targets are never re-inspected: their GET would report the blocked state.
    expect(world.log.some((l) => l.includes('/subdomain'))).toBe(false);
    expect(world.log.some((l) => l.endsWith('/pages/projects/site'))).toBe(false);
  });

  it('blocks a Worker and a Pages project created after the kill, leaving earlier records alone', async () => {
    liveAccount();
    await runScheduled(env, CFG);
    world.scripts.set('late', { enabled: true, previews: false });
    world.pages.set('late-site', { deploymentId: 'late-orig', branch: 'trunk' });

    await runScheduled(env, CFG);

    expect(world.scripts.get('late')?.enabled).toBe(false);
    expect(world.pages.get('late-site')?.deploymentId).toBe('kill-switch-empty');
    const state = await readState(env);
    expect(state.disabledWorkerScripts).toEqual([
      { script: 'app', enabled: true, previewsEnabled: true },
      { script: 'late', enabled: true, previewsEnabled: false },
    ]);
    expect(state.blockedPagesProjects?.map((p) => [p.project, p.previousDeploymentId])).toEqual([
      ['site', 'orig-1'],
      ['late-site', 'late-orig'],
    ]);
    expect(state.pendingWorkerBlocks).toBeUndefined();
    expect(state.pendingPagesBlocks).toBeUndefined();
  });

  it('retries a failed Worker/Pages block each tick and clears it on success', async () => {
    liveAccount();
    world.failSubdomainPost.add('app');
    world.failPagesDeploy.add('site');

    await runScheduled(env, CFG);
    let state = await readState(env);
    // Still recorded, so restore can undo it, and marked pending.
    expect(state.disabledWorkerScripts).toHaveLength(1);
    expect(state.pendingWorkerBlocks).toEqual(['app']);
    expect(state.pendingPagesBlocks).toEqual(['site']);
    expect(world.scripts.get('app')?.enabled).toBe(true);

    putSpy.mockClear();
    await runScheduled(env, CFG); // still failing: retried, nothing changes, nothing written
    expect(mutations(world).length).toBeGreaterThanOrEqual(2);
    expect(stateWrites()).toBe(0);

    world.failSubdomainPost.clear();
    world.failPagesDeploy.clear();
    await runScheduled(env, CFG);

    state = await readState(env);
    expect(state.pendingWorkerBlocks).toBeUndefined();
    expect(state.pendingPagesBlocks).toBeUndefined();
    expect(world.scripts.get('app')?.enabled).toBe(false);
    expect(world.pages.get('site')?.deploymentId).toBe('kill-switch-empty');
    // The recorded originals survived all three ticks.
    expect(state.disabledWorkerScripts).toEqual([
      { script: 'app', enabled: true, previewsEnabled: true },
    ]);
    expect(state.blockedPagesProjects?.[0]?.previousDeploymentId).toBe('orig-1');
  });
});

describe('killed tick — auto-reset', () => {
  it('a day kill resets after 00:00 UTC and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T23:50:00Z'));
    liveAccount();
    await runScheduled(env, CFG);
    expect((await readState(env)).resetWindow).toBe('day');

    world.workersRequests = 0; // the day's usage no longer shows a breach
    vi.setSystemTime(new Date('2026-03-10T23:59:00Z'));
    await runScheduled(env, CFG);
    expect((await readState(env)).status).toBe('killed');

    vi.setSystemTime(new Date('2026-03-11T00:00:30Z'));
    await runScheduled(env, CFG);
    expect((await readState(env)).status).toBe('active');
    expect(world.scripts.get('app')).toEqual({ enabled: true, previews: true });
    expect(world.pages.get('site')?.deploymentId).toBe('orig-1');
  });

  it('a cycle kill does not reset at midnight, only at the billing period start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-14T10:00:00Z'));
    world.scripts.set('app', { enabled: true, previews: false });
    world.r2ClassA = 10;
    const cfg = withLimits({
      r2: { ...CFG.limits.r2, classAOps: { blockAt: 5 } },
    });
    await runScheduled(env, cfg);
    expect((await readState(env)).resetWindow).toBe('cycle');

    world.r2ClassA = 0;
    vi.setSystemTime(new Date('2026-03-15T00:05:00Z')); // next UTC day, same period (day 12)
    await runScheduled(env, cfg);
    expect((await readState(env)).status).toBe('killed');

    vi.setSystemTime(new Date('2026-04-12T00:05:00Z')); // new billing period
    await runScheduled(env, cfg);
    expect((await readState(env)).status).toBe('active');
  });

  it('stays killed, without restoring, when reset is due but a breach persists', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-12T00:05:00Z'));
    world.scripts.set('app', { enabled: false, previews: false });
    await putState(
      killedState({
        resetWindow: 'cycle',
        purgedServices: [],
        disabledWorkerScripts: [{ script: 'app', enabled: true, previewsEnabled: false }],
      }),
    );
    world.r2ClassA = 10; // storage-style ceiling still exceeded after the boundary
    const cfg = withLimits({ r2: { ...CFG.limits.r2, classAOps: { blockAt: 5 } } });
    putSpy.mockClear();
    world.log.length = 0;

    await runScheduled(env, cfg);

    expect((await readState(env)).status).toBe('killed');
    expect(mutations(world)).toHaveLength(0);
    expect(stateWrites()).toBe(0);
  });

  it('resets when metric fetching only errors (fail-open, same as an active tick)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-12T00:05:00Z'));
    world.scripts.set('app', { enabled: false, previews: false });
    await putState(
      killedState({
        disabledWorkerScripts: [{ script: 'app', enabled: true, previewsEnabled: false }],
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async (input: RequestInfo | URL) =>
          urlOf(input).includes('graphql') ? fail(500) : ok({}),
        ),
    );

    await runScheduled(env, CFG);
    expect((await readState(env)).status).toBe('active');
  });

  it("upgrades a 'day' kill to 'cycle' on a cycle breach, with a single KV write", async () => {
    world.scripts.set('app', { enabled: false, previews: false });
    await putState(
      killedState({
        resetWindow: 'day',
        purgedServices: [],
        disabledWorkerScripts: [{ script: 'app', enabled: true, previewsEnabled: false }],
      }),
    );
    world.r2ClassA = 10;
    const cfg = withLimits({ r2: { ...CFG.limits.r2, classAOps: { blockAt: 5 } } });
    putSpy.mockClear();

    await runScheduled(env, cfg);

    const state = await readState(env);
    expect(state.resetWindow).toBe('cycle');
    expect(state.disabledWorkerScripts).toEqual([
      { script: 'app', enabled: true, previewsEnabled: false },
    ]);
    expect(stateWrites()).toBe(1);
  });
});

describe('killed tick — purge', () => {
  const fakeDbCalls: string[] = [];
  const d1Cfg = (): AppConfig =>
    withLimits(
      { d1: { ...CFG.limits.d1, rowReads: { blockAt: 100, purgeAt: 1000 } } },
      {
        purgeConfig: {
          r2: [],
          d1: [{ bindingName: 'FAKE_DB', tables: [{ name: 't', action: 'DELETE_ALL' }] }],
        },
      },
    );

  beforeEach(() => {
    fakeDbCalls.length = 0;
    (env as unknown as Record<string, unknown>).FAKE_DB = {
      prepare: (sql: string) => ({
        run: async () => {
          fakeDbCalls.push(sql);
        },
      }),
    };
  });
  afterEach(() => {
    delete (env as unknown as Record<string, unknown>).FAKE_DB;
  });

  it('purges once when purgeAt is reached on a killed tick, not on the following tick', async () => {
    world.workersRequests = 0;
    world.d1RowsRead = 200; // block-level only
    await runScheduled(env, d1Cfg());
    expect((await readState(env)).purgedServices).toEqual([]);
    expect(fakeDbCalls).toHaveLength(0);

    world.d1RowsRead = 5000; // now purge-level, on a killed tick
    await runScheduled(env, d1Cfg());
    expect(fakeDbCalls).toEqual(['DELETE FROM `t`']);
    expect((await readState(env)).purgedServices).toEqual(['d1']);

    putSpy.mockClear();
    await runScheduled(env, d1Cfg());
    expect(fakeDbCalls).toHaveLength(1);
    expect(stateWrites()).toBe(0);
  });

  it('purges during the first kill and records it', async () => {
    world.d1RowsRead = 5000;
    await runScheduled(env, d1Cfg());
    expect(fakeDbCalls).toHaveLength(1);
    expect((await readState(env)).purgedServices).toEqual(['d1']);

    await runScheduled(env, d1Cfg());
    expect(fakeDbCalls).toHaveLength(1);
  });

  it('never purges on a killed tick for a legacy state without purgedServices', async () => {
    await putState(killedState({ disabledWorkerScripts: ['gone'] }));
    world.d1RowsRead = 5000;
    putSpy.mockClear();

    await runScheduled(env, d1Cfg());

    expect(fakeDbCalls).toHaveLength(0);
    expect((await readState(env)).purgedServices).toBeUndefined();
    expect(stateWrites()).toBe(0);
  });
});

describe('killed tick — WAF', () => {
  const zoneCfg = (): AppConfig => ({
    ...CFG,
    scope: 'zone',
    blocking: { workers: [], pages: [] },
  });

  it('retries a WAF deploy that failed during the kill', async () => {
    world.workersRequests = 500;
    world.wafDown = true;
    await runScheduled(env, zoneCfg());
    expect((await readState(env)).wafRuleId).toBeUndefined();

    world.wafDown = false;
    await runScheduled(env, zoneCfg());
    const state = await readState(env);
    expect(state.wafRuleId).toBe('rule-1');
    expect(state.wafRulesetId).toBe('rs-1');
  });

  it('adopts a rule that an earlier, apparently failed deploy already created', async () => {
    world.workersRequests = 500;
    world.wafRules.push({ id: 'ghost-rule', description: WAF_DESCRIPTION });
    await runScheduled(env, zoneCfg());

    const state = await readState(env);
    expect(state.wafRuleId).toBe('ghost-rule');
    expect(world.wafRules).toHaveLength(1);
    expect(mutations(world)).toHaveLength(0);
  });
});

describe('killed tick — state written by v2.0.0', () => {
  it('keeps working: no resetWindow (cycle), no purge, string[] workers, then restores', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-11T00:05:00Z')); // same billing period as the kill
    world.scripts.set('legacy', { enabled: false, previews: false });
    await putState(killedState({ disabledWorkerScripts: ['legacy'] }));
    world.d1RowsRead = 0;
    const cfg: AppConfig = { ...CFG, blocking: { workers: ['legacy'], pages: [] } };
    world.workersRequests = 0;
    putSpy.mockClear();
    world.log.length = 0;

    await runScheduled(env, cfg); // killed tick: nothing to do

    expect(stateWrites()).toBe(0);
    expect(world.log.some((l) => l.includes('/subdomain'))).toBe(false);
    const state = await readState(env);
    expect(state.disabledWorkerScripts).toEqual(['legacy']);

    const result = await restoreFromState(env, cfg, state);
    expect(result.fullyRestored).toBe(true);
    const restore = world.log.filter((l) => l.startsWith('POST') && l.includes('/subdomain'));
    expect(restore).toHaveLength(1);
    expect(world.scripts.get('legacy')?.enabled).toBe(true);
  });

  it('treats a legacy state as a cycle kill for auto-reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-11T00:05:00Z')); // next UTC day, same billing period
    await putState(killedState({ killedAt: '2026-03-10T12:00:00.000Z' }));
    await runScheduled(env, { ...CFG, blocking: { workers: [], pages: [] } });
    expect((await readState(env)).status).toBe('killed');
  });
});
