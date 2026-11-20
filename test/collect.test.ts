import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { MODULES } from '../src/metrics/index.js';
import { collectUsage, type ModuleOutcome } from '../src/metrics/collect.js';
import { evaluateCombined } from '../src/metrics/combined.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const cfg: AppConfig = { ...CONFIG, billingCycleDay: 1 };

const account = {
  workersInvocationsAdaptive: [{ sum: { requests: 10 } }],
  pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 5 } }],
  kvOperationsAdaptiveGroups: [],
  kvStorageAdaptiveGroups: [],
  r2OperationsAdaptiveGroups: [],
  r2StorageAdaptiveGroups: [],
  d1AnalyticsAdaptiveGroups: [],
  d1StorageAdaptiveGroups: [],
};

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const ok = (acc: Record<string, unknown> = account) =>
  reply({ data: { viewer: { accounts: [acc] } } });

function sentQueries(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(
      ([, init]) => (JSON.parse((init as RequestInit).body as string) as { query: string }).query,
    );
}

function summarize(outcomes: ModuleOutcome[]) {
  return Object.fromEntries(
    MODULES.map((m, i) => {
      const outcome = outcomes[i];
      return [m.name, outcome && 'error' in outcome ? 'error' : 'ok'];
    }),
  );
}

const ALL_OK = { workers: 'ok', pages: 'ok', kv: 'ok', r2: 'ok', d1: 'ok' };

describe('collectUsage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('sends every module in one request', async () => {
    vi.mocked(fetch).mockImplementation(() => ok());
    const outcomes = await collectUsage(env, cfg, MODULES);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(summarize(outcomes)).toEqual(ALL_OK);
  });

  it('fails only the blamed module when partial data comes back', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      reply({
        data: { viewer: { accounts: [{ ...account, kvStorageAdaptiveGroups: null }] } },
        errors: [{ message: 'boom', path: ['viewer', 'accounts', 0, 'kvStorageAdaptiveGroups'] }],
      }),
    );
    const outcomes = await collectUsage(env, cfg, MODULES);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(summarize(outcomes)).toEqual({ ...ALL_OK, kv: 'error' });
  });

  it('re-requests the rest without the blamed module when data is null', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        reply({
          data: null,
          errors: [{ message: 'boom', path: ['viewer', 'accounts', 0, 'd1StorageAdaptiveGroups'] }],
        }),
      )
      .mockImplementation(() => ok());
    const outcomes = await collectUsage(env, cfg, MODULES);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sentQueries()[1]).not.toContain('d1StorageAdaptiveGroups');
    expect(summarize(outcomes)).toEqual({ ...ALL_OK, d1: 'error' });
  });

  it('falls back to one request per module when an error has no path', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() => reply({ data: null, errors: [{ message: 'vague' }] }))
      .mockImplementation(() => ok());
    const outcomes = await collectUsage(env, cfg, MODULES);
    expect(fetch).toHaveBeenCalledTimes(1 + MODULES.length);
    expect(summarize(outcomes)).toEqual(ALL_OK);
  });

  it('fails all modules without fanning out on an HTTP-level failure', async () => {
    vi.mocked(fetch).mockImplementation(() => reply('nope', 401));
    const outcomes = await collectUsage(env, cfg, MODULES);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.values(summarize(outcomes)).every((v) => v === 'error')).toBe(true);
  });

  it('falls back to one request per module when the merged request times out', async () => {
    const timeout = () => Promise.reject(new DOMException('aborted', 'TimeoutError'));
    vi.mocked(fetch)
      .mockImplementationOnce(timeout)
      .mockImplementationOnce(timeout)
      .mockImplementation(() => ok());
    const outcomes = await collectUsage(env, cfg, MODULES);
    // Two merged attempts (fetchRetry), then one request per module.
    expect(fetch).toHaveBeenCalledTimes(2 + MODULES.length);
    expect(summarize(outcomes)).toEqual(ALL_OK);
  });

  it('fails only the module whose own data is untrustworthy', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      ok({
        ...account,
        kvOperationsAdaptiveGroups: [{ sum: { requests: 1 }, dimensions: { actionType: 'read' } }],
      }),
    );
    const outcomes = await collectUsage(env, cfg, MODULES);
    expect(summarize(outcomes)).toEqual({ ...ALL_OK, kv: 'error' });
  });
});

describe('evaluateCombined', () => {
  const sample = (value: number): ModuleOutcome => ({
    samples: [{ metric: 'requests', value, window: 'day' }],
  });
  const withCombined = (blockAt: number): AppConfig => ({
    ...cfg,
    limits: { ...cfg.limits, combined: { requests: { blockAt } } },
  });

  it('trips when each is under its own limit but the sum is not', () => {
    const r = evaluateCombined(
      { workers: sample(60_000), pages: sample(60_000) },
      withCombined(100_000),
    );
    expect(r.breaches).toHaveLength(1);
    expect(r.breaches[0]).toMatchObject({
      service: 'combined',
      metric: 'requests',
      observed: 120_000,
      window: 'day',
    });
  });

  it('stays quiet under the limit', () => {
    const r = evaluateCombined(
      { workers: sample(40_000), pages: sample(40_000) },
      withCombined(100_000),
    );
    expect(r).toEqual({ breaches: [], errors: [] });
  });

  it('skips and reports when either side failed', () => {
    const r = evaluateCombined(
      { workers: sample(99_000), pages: { error: 'x' } },
      withCombined(100_000),
    );
    expect(r.breaches).toEqual([]);
    expect(r.errors[0]).toMatch(/combined: skipped.*pages/);
  });

  it('does nothing when limits.combined is absent', () => {
    const { combined: _combined, ...limits } = cfg.limits;
    expect(
      evaluateCombined({ workers: sample(1e9), pages: sample(1e9) }, { ...cfg, limits }),
    ).toEqual({ breaches: [], errors: [] });
  });
});
