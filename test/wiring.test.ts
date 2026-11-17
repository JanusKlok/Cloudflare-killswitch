import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { runScheduled } from '../src/scheduled.js';
import { restoreFromState } from '../src/restore.js';
import { handleFetch } from '../src/recovery.js';
import { readState, writeActive } from '../src/state.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig, Env, KvState } from '../src/types.js';
import { urlOf } from './helpers.js';

// Wiring tests for R2 blocking (block-r2 -> scheduled/restore) and for the alert
// fan-out (alerts/webhook -> scheduled/recovery), on a small stateful fake of
// the Cloudflare API.

const WEBHOOK_URL = 'https://ntfy.sh/test-topic';
const METRIC_ALERT_KEY = 'metric-failure-alert-day';
const HUGE = 1_000_000_000_000;

interface World {
  workersRequests: number;
  /** bucket -> is its r2.dev URL on */
  r2: Map<string, { enabled: boolean }>;
  failR2Put: Set<string>;
  failR2Get: Set<string>;
  graphqlDown: boolean;
  log: string[];
  /** KV 'state' as stored at the moment each managed-domain PUT arrived */
  stateAtPut: { bucket: string; enabled: boolean; state: KvState }[];
  webhooks: { title: string; body: string }[];
}

function newWorld(): World {
  return {
    workersRequests: 0,
    r2: new Map(),
    failR2Put: new Set(),
    failR2Get: new Set(),
    graphqlDown: false,
    log: [],
    stateAtPut: [],
    webhooks: [],
  };
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const fail = (status: number) =>
  new Response(JSON.stringify({ success: false, errors: [{ code: status, message: 'boom' }] }), {
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

function installWorld(w: World) {
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';

    if (url.startsWith(WEBHOOK_URL)) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      w.webhooks.push({
        title: headers['Title'] ?? '',
        body: (init?.body as string | undefined) ?? '',
      });
      w.log.push(`WEBHOOK ${headers['Title'] ?? ''}`);
      return new Response('ok', { status: 200 });
    }

    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    w.log.push(`${method} ${path}`);

    if (url.includes('graphql')) {
      if (w.graphqlDown) return fail(500);
      return new Response(JSON.stringify(graphqlBody(w)), { status: 200 });
    }

    const managed = /\/r2\/buckets\/([^/]+)\/domains\/managed$/.exec(path);
    if (managed?.[1]) {
      const name = decodeURIComponent(managed[1]);
      const bucket = w.r2.get(name);
      if (method === 'PUT') {
        if (w.failR2Put.has(name)) return fail(500);
        const body = JSON.parse(init?.body as string) as { enabled: boolean };
        const stored = await env.KILL_SWITCH_STATE.get('state');
        w.stateAtPut.push({
          bucket: name,
          enabled: body.enabled,
          state: stored ? (JSON.parse(stored) as KvState) : ({ status: 'active' } as KvState),
        });
        if (bucket) bucket.enabled = body.enabled;
        return ok({ enabled: body.enabled });
      }
      if (w.failR2Get.has(name)) return fail(400);
      if (!bucket) return fail(404);
      return ok({ enabled: bucket.enabled });
    }
    if (/\/r2\/buckets(\?|$)/.test(path)) {
      // Only the default jurisdiction holds buckets in this fake.
      const jurisdiction =
        (init?.headers as Record<string, string> | undefined)?.['cf-r2-jurisdiction'] ?? 'default';
      const names = jurisdiction === 'default' ? [...w.r2.keys()].sort() : [];
      return ok({ buckets: names.map((name) => ({ name })) });
    }

    return ok({});
  };
  vi.stubGlobal('fetch', vi.fn(handler));
}

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
  blocking: { workers: [], pages: [], r2: 'all' },
};
const CFG_RECOVERY: AppConfig = { ...CFG, enableRecoveryWebhook: true };

const wenv = { ...env, ALERT_WEBHOOK_URL: WEBHOOK_URL } as Env;

let world: World;
let putSpy: {
  mock: { calls: unknown[][] };
  mockClear(): void;
  mockRestore(): void;
};

const stateWrites = () => putSpy.mock.calls.filter(([key]) => key === 'state').length;
const managedCalls = (w: World, method: string, bucket?: string) =>
  w.log.filter(
    (l) =>
      l.startsWith(`${method} `) &&
      l.endsWith('/domains/managed') &&
      (bucket === undefined || l.includes(`/buckets/${bucket}/`)),
  );
const killedState = (over: Partial<KvState>): KvState => ({
  status: 'killed',
  timestamp: '2026-03-10T12:00:00.000Z',
  killedAt: '2026-03-10T12:00:00.000Z',
  reason: 'test',
  ...over,
});
const putState = (s: KvState) => env.KILL_SWITCH_STATE.put('state', JSON.stringify(s));

let ipCounter = 0;
function restoreRequest(): Request {
  ipCounter += 1;
  return new Request('http://worker/restore', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RECOVERY_SECRET}`,
      'CF-Connecting-IP': `203.0.113.${ipCounter % 250}`,
    },
  });
}
// No RESTORE_RATE_LIMITER binding: the in-memory fallback limiter keeps tests independent.
const recoveryEnv = { ...wenv, RESTORE_RATE_LIMITER: undefined } as unknown as Env;

beforeEach(async () => {
  await writeActive(env);
  await env.KILL_SWITCH_STATE.delete(METRIC_ALERT_KEY);
  world = newWorld();
  installWorld(world);
  putSpy = vi.spyOn(env.KILL_SWITCH_STATE, 'put');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  putSpy.mockRestore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await writeActive(env);
  await env.KILL_SWITCH_STATE.delete(METRIC_ALERT_KEY);
});

function publicAndPrivate() {
  world.r2.set('pub', { enabled: true });
  world.r2.set('priv', { enabled: false });
  world.workersRequests = 500;
}

describe('R2 wiring — first kill', () => {
  it('records and disables a public bucket, leaves a private one alone, state written before the PUT', async () => {
    publicAndPrivate();
    await runScheduled(env, CFG);

    expect(world.r2.get('pub')?.enabled).toBe(false);
    expect(world.r2.get('priv')?.enabled).toBe(false);
    expect(managedCalls(world, 'PUT', 'priv')).toHaveLength(0);
    expect(managedCalls(world, 'PUT')).toHaveLength(1);

    // Record + pending were already in KV when the disable PUT arrived.
    expect(world.stateAtPut).toHaveLength(1);
    const atPut = world.stateAtPut[0];
    expect(atPut?.bucket).toBe('pub');
    expect(atPut?.enabled).toBe(false);
    expect(atPut?.state.status).toBe('killed');
    expect(atPut?.state.blockedR2Buckets).toEqual([{ bucket: 'pub' }]);
    expect(atPut?.state.pendingR2Blocks).toEqual(['pub']);

    // Call order: the resolving GETs precede the PUT.
    const firstPut = world.log.findIndex((l) => l.startsWith('PUT '));
    const lastGet = world.log
      .map((l) => l.startsWith('GET ') && l.endsWith('/domains/managed'))
      .lastIndexOf(true);
    expect(lastGet).toBeGreaterThanOrEqual(0);
    expect(lastGet).toBeLessThan(firstPut);

    const state = await readState(env);
    expect(state.blockedR2Buckets).toEqual([{ bucket: 'pub' }]);
    expect(state.pendingR2Blocks).toBeUndefined();
  });
});

describe('R2 wiring — repeated ticks and restore', () => {
  it('two killed ticks do not re-read the known bucket; restore re-enables it', async () => {
    publicAndPrivate();
    await runScheduled(env, CFG);
    world.log.length = 0;
    putSpy.mockClear();

    await runScheduled(env, CFG);
    await runScheduled(env, CFG);

    // Reading a disabled bucket would report the blocked state, never the original.
    expect(managedCalls(world, 'GET', 'pub')).toHaveLength(0);
    expect(managedCalls(world, 'PUT')).toHaveLength(0);
    expect(stateWrites()).toBe(0);

    const state = await readState(env);
    expect(state.blockedR2Buckets).toEqual([{ bucket: 'pub' }]);

    const result = await restoreFromState(env, CFG, state);
    expect(result.fullyRestored).toBe(true);
    expect(world.r2.get('pub')?.enabled).toBe(true);
    expect(world.r2.get('priv')?.enabled).toBe(false); // never made public
    expect(world.stateAtPut.at(-1)).toMatchObject({ bucket: 'pub', enabled: true });
    expect((await readState(env)).status).toBe('active');
  });
});

describe('R2 wiring — failed disable', () => {
  it('stays recorded and pending, is retried each tick, and clears on success', async () => {
    publicAndPrivate();
    world.failR2Put.add('pub');

    await runScheduled(wenv, CFG);
    let state = await readState(env);
    expect(state.blockedR2Buckets).toEqual([{ bucket: 'pub' }]);
    expect(state.pendingR2Blocks).toEqual(['pub']);
    expect(world.r2.get('pub')?.enabled).toBe(true);

    putSpy.mockClear();
    world.log.length = 0;
    world.webhooks.length = 0;
    await runScheduled(wenv, CFG); // still failing
    expect(managedCalls(world, 'PUT', 'pub').length).toBeGreaterThanOrEqual(1);
    expect(stateWrites()).toBe(0);
    expect(world.webhooks).toHaveLength(0); // a target that keeps failing is not news

    world.failR2Put.clear();
    await runScheduled(wenv, CFG);
    state = await readState(env);
    expect(state.pendingR2Blocks).toBeUndefined();
    expect(state.blockedR2Buckets).toEqual([{ bucket: 'pub' }]);
    expect(world.r2.get('pub')?.enabled).toBe(false);
    expect(world.webhooks).toHaveLength(1); // the block finally landing is news
  });
});

describe('R2 wiring — priorStateUnknown', () => {
  it('is blocked on kill, left off on restore, noted, and restore is still full', async () => {
    world.r2.set('pub', { enabled: true });
    world.r2.set('mystery', { enabled: true });
    world.failR2Get.add('mystery');
    world.workersRequests = 500;

    await runScheduled(env, CFG);

    expect(world.r2.get('mystery')?.enabled).toBe(false);
    expect(world.r2.get('pub')?.enabled).toBe(false);
    const state = await readState(env);
    expect(state.blockedR2Buckets).toEqual([
      { bucket: 'mystery', priorStateUnknown: true },
      { bucket: 'pub' },
    ]);

    world.failR2Get.clear();
    const result = await restoreFromState(env, CFG, state);

    expect(result.fullyRestored).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('mystery');
    expect(result.notes[0]).not.toContain('pub,');
    expect(managedCalls(world, 'PUT', 'mystery')).toHaveLength(1); // only the kill
    expect(world.r2.get('mystery')?.enabled).toBe(false);
    expect(world.r2.get('pub')?.enabled).toBe(true);
    expect((await readState(env)).status).toBe('active');
  });

  it('surfaces the note through POST /restore', async () => {
    world.r2.set('mystery', { enabled: true });
    world.failR2Get.add('mystery');
    world.workersRequests = 500;
    await runScheduled(env, CFG_RECOVERY);

    const res = await handleFetch(restoreRequest(), recoveryEnv, CFG_RECOVERY);
    const body = (await res.json()) as { restored: boolean; notes: string[] };
    expect(res.status).toBe(200);
    expect(body.restored).toBe(true);
    expect(body.notes.join(' ')).toContain('mystery');
  });
});

describe('R2 wiring — partial restore', () => {
  it('keeps only the failed buckets recorded, then finishes on retry', async () => {
    world.r2.set('pub1', { enabled: true });
    world.r2.set('pub2', { enabled: true });
    world.workersRequests = 500;
    await runScheduled(env, CFG);
    expect(world.r2.get('pub1')?.enabled).toBe(false);
    expect(world.r2.get('pub2')?.enabled).toBe(false);

    world.failR2Put.add('pub2');
    const result = await restoreFromState(env, CFG, await readState(env));

    expect(result.fullyRestored).toBe(false);
    expect(result.errors.join(' ')).toContain('pub2');
    expect(world.r2.get('pub1')?.enabled).toBe(true);
    expect(world.r2.get('pub2')?.enabled).toBe(false);
    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.blockedR2Buckets).toEqual([{ bucket: 'pub2' }]);
    expect(state.pendingR2Blocks).toBeUndefined();

    world.failR2Put.clear();
    const retry = await restoreFromState(env, CFG, state);
    expect(retry.fullyRestored).toBe(true);
    expect(world.r2.get('pub2')?.enabled).toBe(true);
    expect((await readState(env)).status).toBe('active');
  });
});

describe('alert wiring — webhook', () => {
  it('posts on the first kill and not on a quiet killed tick', async () => {
    publicAndPrivate();
    await runScheduled(wenv, CFG);

    expect(world.webhooks).toHaveLength(1);
    expect(world.webhooks[0]?.title).toContain('Traffic blocked');
    expect(world.webhooks[0]?.body).toContain('pub');

    world.log.length = 0;
    await runScheduled(wenv, CFG);
    expect(world.webhooks).toHaveLength(1);
    expect(world.log.some((l) => l.startsWith('WEBHOOK'))).toBe(false);
  });

  it('posts on a killed tick that blocks a newly appeared bucket', async () => {
    publicAndPrivate();
    await runScheduled(wenv, CFG);
    world.r2.set('late', { enabled: true });

    await runScheduled(wenv, CFG);

    expect(world.webhooks).toHaveLength(2);
    expect(world.webhooks[1]?.title).toContain('Still blocked');
    expect(world.webhooks[1]?.body).toContain('late');
    expect(world.r2.get('late')?.enabled).toBe(false);
  });

  it('posts on auto-reset success', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T23:50:00Z'));
    publicAndPrivate();
    await runScheduled(wenv, CFG);
    expect(world.webhooks).toHaveLength(1);

    world.workersRequests = 0;
    vi.setSystemTime(new Date('2026-03-11T00:00:30Z'));
    await runScheduled(wenv, CFG);

    expect((await readState(env)).status).toBe('active');
    expect(world.r2.get('pub')?.enabled).toBe(true);
    expect(world.webhooks).toHaveLength(2);
    expect(world.webhooks[1]?.title).toContain('Auto-reset');
  });

  it('posts on a partly failed auto-reset', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T23:50:00Z'));
    publicAndPrivate();
    await runScheduled(wenv, CFG);

    world.workersRequests = 0;
    world.failR2Put.add('pub');
    vi.setSystemTime(new Date('2026-03-11T00:00:30Z'));
    await runScheduled(wenv, CFG);

    expect((await readState(env)).status).toBe('killed');
    expect(world.webhooks).toHaveLength(2);
    expect(world.webhooks[1]?.title).toContain('Restore partly failed');
    expect(world.webhooks[1]?.body).toContain('pub');

    // The same item failing again: no second alert, no state rewrite.
    const before = await env.KILL_SWITCH_STATE.get('state');
    vi.setSystemTime(new Date('2026-03-11T00:05:30Z'));
    await runScheduled(wenv, CFG);
    expect(world.webhooks).toHaveLength(2);
    expect(await env.KILL_SWITCH_STATE.get('state')).toBe(before);

    // Once it succeeds the remnant is finished and traffic is fully restored.
    world.failR2Put.delete('pub');
    vi.setSystemTime(new Date('2026-03-11T00:10:30Z'));
    await runScheduled(wenv, CFG);
    expect((await readState(env)).status).toBe('active');
    expect(world.webhooks[2]?.title).toContain('Restore completed');
  });

  it('finishes a partly failed /restore on the next tick instead of re-killing', async () => {
    publicAndPrivate();
    await runScheduled(recoveryEnv, CFG_RECOVERY);
    world.workersRequests = 0;
    world.failR2Put.add('pub');

    const res = await handleFetch(restoreRequest(), recoveryEnv, CFG_RECOVERY);
    expect(res.status).toBe(502);
    const remnant = await readState(env);
    expect(remnant.status).toBe('killed');
    expect(remnant.restorePending).toBe(true);

    world.failR2Put.delete('pub');
    world.log.length = 0;
    world.stateAtPut.length = 0;
    await runScheduled(recoveryEnv, CFG_RECOVERY);

    // No re-blocking of anything: only the remnant's enabled:true PUT went out.
    expect(world.stateAtPut.map((p) => [p.bucket, p.enabled])).toEqual([['pub', true]]);
    expect(world.r2.get('pub')?.enabled).toBe(true);
    expect(world.log.some((l) => l.startsWith('POST') && l.includes('/subdomain'))).toBe(false);
    expect(world.log.some((l) => l.includes('/deployments'))).toBe(false);
    expect((await readState(env)).status).toBe('active');
  });

  it('posts on POST /restore success', async () => {
    publicAndPrivate();
    await runScheduled(recoveryEnv, CFG_RECOVERY);
    world.webhooks.length = 0;

    const res = await handleFetch(restoreRequest(), recoveryEnv, CFG_RECOVERY);

    expect(res.status).toBe(200);
    expect(world.webhooks).toHaveLength(1);
    expect(world.webhooks[0]?.title).toContain('Restored via /restore');
    expect(world.r2.get('pub')?.enabled).toBe(true);
  });

  it('does not post when /restore fails partially', async () => {
    publicAndPrivate();
    await runScheduled(recoveryEnv, CFG_RECOVERY);
    world.webhooks.length = 0;
    world.failR2Put.add('pub');

    const res = await handleFetch(restoreRequest(), recoveryEnv, CFG_RECOVERY);

    expect(res.status).toBe(502);
    expect(world.webhooks).toHaveLength(0);
  });

  it('does nothing without ALERT_WEBHOOK_URL', async () => {
    publicAndPrivate();
    await runScheduled(env, CFG);
    expect(world.webhooks).toHaveLength(0);
  });
});

describe('alert wiring — metric failures', () => {
  it('alerts once per UTC day and writes the day key only once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T08:00:00Z'));
    world.graphqlDown = true;

    await runScheduled(wenv, CFG);

    expect(world.webhooks).toHaveLength(1);
    expect(world.webhooks[0]?.title).toContain('Usage checks are failing');
    expect(await env.KILL_SWITCH_STATE.get(METRIC_ALERT_KEY)).toBe('2026-03-10');
    expect((await readState(env)).status).toBe('active'); // errors alone never kill

    putSpy.mockClear();
    vi.setSystemTime(new Date('2026-03-10T08:05:00Z'));
    await runScheduled(wenv, CFG);

    expect(world.webhooks).toHaveLength(1);
    expect(putSpy.mock.calls.filter(([key]) => key === METRIC_ALERT_KEY)).toHaveLength(0);

    vi.setSystemTime(new Date('2026-03-11T08:00:00Z'));
    await runScheduled(wenv, CFG);
    expect(world.webhooks).toHaveLength(2);
    expect(await env.KILL_SWITCH_STATE.get(METRIC_ALERT_KEY)).toBe('2026-03-11');
  });

  it('alerts on a killed tick too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T08:00:00Z'));
    await putState(killedState({ resetWindow: 'cycle', purgedServices: [] }));
    world.graphqlDown = true;

    await runScheduled(wenv, CFG);

    expect(world.webhooks.map((w) => w.title)).toEqual(['[Kill Switch] Usage checks are failing']);
  });
});

describe('R2 wiring — state written by v2.0.0', () => {
  it('a killed tick records new buckets, and restore works', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-11T00:05:00Z')); // same billing period as the kill
    world.r2.set('pub', { enabled: true });
    world.r2.set('priv', { enabled: false });
    // No resetWindow, purgedServices, pending* or R2 fields.
    await putState(killedState({}));

    await runScheduled(wenv, CFG);

    expect(world.r2.get('pub')?.enabled).toBe(false);
    expect(managedCalls(world, 'PUT')).toHaveLength(1);
    let state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.blockedR2Buckets).toEqual([{ bucket: 'pub' }]);
    expect(state.pendingR2Blocks).toBeUndefined();
    expect(state.purgedServices).toBeUndefined(); // still marked as never-purge
    expect(world.webhooks).toHaveLength(1);
    expect(world.webhooks[0]?.title).toContain('Still blocked');

    state = await readState(env);
    const result = await restoreFromState(env, CFG, state);
    expect(result.fullyRestored).toBe(true);
    expect(world.r2.get('pub')?.enabled).toBe(true);
    expect(world.r2.get('priv')?.enabled).toBe(false);
    expect((await readState(env)).status).toBe('active');
  });
});
