import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { kvModule } from '../src/metrics/kv.js';
import { r2Module } from '../src/metrics/r2.js';
import { d1Module } from '../src/metrics/d1.js';
import { workersModule } from '../src/metrics/workers.js';
import { pagesModule } from '../src/metrics/pages.js';
import { sumPerEntityMax } from '../src/metrics/storage.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig, MetricSample } from '../src/types.js';

// Every module aggregates GraphQL rows by matching hardcoded dimension strings.
// The pre-existing tests mocked all of these datasets as [], so no row ever
// reached the aggregation code: a wrong field or dimension name would leave the
// counter at 0, report "no breach" forever, and keep the suite green.
const cfg: AppConfig = { ...CONFIG, billingCycleDay: 1 };

function gqlReply(account: Record<string, unknown>) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), { status: 200 }),
    );
}

function valueOf(samples: MetricSample[], metric: string): number {
  const sample = samples.find((s) => s.metric === metric);
  if (!sample) throw new Error(`no sample for metric "${metric}"`);
  return sample.value;
}

describe('sumPerEntityMax', () => {
  const rows = [
    { id: 'a', bytes: 10 },
    { id: 'a', bytes: 40 },
    { id: 'b', bytes: 25 },
  ];

  it('sums the per-entity maximum, not the grand max or the total', () => {
    // max-per-entity: a=40, b=25 -> 65. An ungrouped max would say 40.
    const total = sumPerEntityMax('svc', 'f', rows, (r) => r.id, (r) => r.bytes, true);
    expect(total).toBe(65);
  });

  it('reports 0 for a service with no rows and no activity', () => {
    expect(sumPerEntityMax('svc', 'f', [], () => '', () => 0, false)).toBe(0);
  });

  it('throws rather than reporting 0 when the service saw activity', () => {
    expect(() => sumPerEntityMax('svc', 'f', [], () => '', () => 0, true)).toThrow(
      /rather than 0/,
    );
  });

  it('throws on a non-finite value instead of poisoning the total with NaN', () => {
    expect(() =>
      sumPerEntityMax('svc', 'f', [{ id: 'a', bytes: NaN }], (r) => r.id, (r) => r.bytes, true),
    ).toThrow(/finite/);
  });
});

describe('workersModule.fetchUsage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('sums requests across rows', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({
        workersInvocationsAdaptive: [
          { sum: { requests: 1_200 } },
          { sum: { requests: 800 } },
        ],
      }),
    );
    const samples = await workersModule.fetchUsage(env, cfg);
    expect(valueOf(samples, 'requests')).toBe(2_000);
    expect(samples[0]?.window).toBe('day');
  });

  it('evaluates its own samples against the workers limits', () => {
    const breaches = workersModule.evaluate(
      [{ metric: 'requests', value: 100_000, window: 'day' }],
      cfg,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.service).toBe('workers');
  });
});

describe('pagesModule.fetchUsage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('sums Pages Functions invocations', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({ pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 4_321 } }] }),
    );
    const samples = await pagesModule.fetchUsage(env, cfg);
    expect(valueOf(samples, 'requests')).toBe(4_321);
  });
});

describe('kvModule.fetchUsage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const ops = [
    { sum: { requests: 500 }, dimensions: { actionType: 'read' } },
    { sum: { requests: 30 }, dimensions: { actionType: 'write' } },
    { sum: { requests: 7 }, dimensions: { actionType: 'delete' } },
    { sum: { requests: 3 }, dimensions: { actionType: 'list' } },
  ];

  it('splits reads from writes and sums storage per namespace', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({
        kvOperationsAdaptiveGroups: ops,
        kvStorageAdaptiveGroups: [
          { max: { byteCount: 1_000 }, dimensions: { namespaceId: 'ns-1' } },
          { max: { byteCount: 4_000 }, dimensions: { namespaceId: 'ns-1' } },
          { max: { byteCount: 2_500 }, dimensions: { namespaceId: 'ns-2' } },
        ],
      }),
    );

    const samples = await kvModule.fetchUsage(env, cfg);
    expect(valueOf(samples, 'reads')).toBe(500);
    // write + delete + list are metered separately by Cloudflare but share one
    // counter here, so this documents the deliberate over-count.
    expect(valueOf(samples, 'writes')).toBe(40);
    expect(valueOf(samples, 'storageBytes')).toBe(6_500);
  });

  it('reports zero for an account with no KV usage at all', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({ kvOperationsAdaptiveGroups: [], kvStorageAdaptiveGroups: [] }),
    );
    const samples = await kvModule.fetchUsage(env, cfg);
    expect(valueOf(samples, 'storageBytes')).toBe(0);
  });

  it('throws when storage is missing but operations happened', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({ kvOperationsAdaptiveGroups: ops, kvStorageAdaptiveGroups: [] }),
    );
    await expect(kvModule.fetchUsage(env, cfg)).rejects.toThrow(/rather than 0/);
  });

  it('maps every emitted metric name onto a configured limit', () => {
    const samples = [
      { metric: 'reads', value: Number.MAX_SAFE_INTEGER, window: 'day' as const },
      { metric: 'writes', value: Number.MAX_SAFE_INTEGER, window: 'day' as const },
      { metric: 'storageBytes', value: Number.MAX_SAFE_INTEGER, window: 'cycle' as const },
    ];
    // A metric with no matching limits key would silently evaluate to nothing.
    expect(kvModule.evaluate(samples, cfg)).toHaveLength(samples.length);
  });
});

describe('r2Module.fetchUsage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('classifies operations and sums storage per bucket', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({
        r2OperationsAdaptiveGroups: [
          { sum: { requests: 10 }, dimensions: { actionType: 'PutObject' } },
          { sum: { requests: 5 }, dimensions: { actionType: 'DeleteObject' } },
          { sum: { requests: 900 }, dimensions: { actionType: 'GetObject' } },
          { sum: { requests: 100 }, dimensions: { actionType: 'HeadObject' } },
        ],
        r2StorageAdaptiveGroups: [
          { max: { payloadSize: 5_000 }, dimensions: { bucketName: 'uploads' } },
          { max: { payloadSize: 1_000 }, dimensions: { bucketName: 'backups' } },
        ],
      }),
    );

    const samples = await r2Module.fetchUsage(env, cfg);
    expect(valueOf(samples, 'classAOps')).toBe(15);
    expect(valueOf(samples, 'classBOps')).toBe(1_000);
    expect(valueOf(samples, 'storageBytes')).toBe(6_000);
  });

  it('warns instead of silently dropping an unclassified operation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetch).mockImplementation(
      gqlReply({
        r2OperationsAdaptiveGroups: [
          { sum: { requests: 42 }, dimensions: { actionType: 'SomeFutureOperation' } },
        ],
        r2StorageAdaptiveGroups: [
          { max: { payloadSize: 1 }, dimensions: { bucketName: 'b' } },
        ],
      }),
    );

    await r2Module.fetchUsage(env, cfg);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SomeFutureOperation'));
    warn.mockRestore();
  });

  it('maps every emitted metric name onto a configured limit', () => {
    const samples = [
      { metric: 'storageBytes', value: Number.MAX_SAFE_INTEGER, window: 'cycle' as const },
      { metric: 'classAOps', value: Number.MAX_SAFE_INTEGER, window: 'cycle' as const },
      { metric: 'classBOps', value: Number.MAX_SAFE_INTEGER, window: 'cycle' as const },
    ];
    expect(r2Module.evaluate(samples, cfg)).toHaveLength(samples.length);
  });
});

describe('d1Module.fetchUsage', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('sums row reads and writes and storage per database', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({
        d1AnalyticsAdaptiveGroups: [
          { sum: { rowsRead: 1_000, rowsWritten: 10 } },
          { sum: { rowsRead: 500, rowsWritten: 5 } },
        ],
        d1StorageAdaptiveGroups: [
          { max: { databaseSizeBytes: 900 }, dimensions: { databaseId: 'db-1' } },
          { max: { databaseSizeBytes: 100 }, dimensions: { databaseId: 'db-2' } },
        ],
      }),
    );

    const samples = await d1Module.fetchUsage(env, cfg);
    expect(valueOf(samples, 'rowReads')).toBe(1_500);
    expect(valueOf(samples, 'rowWrites')).toBe(15);
    expect(valueOf(samples, 'storageBytes')).toBe(1_000);
  });

  it('maps every emitted metric name onto a configured limit', () => {
    const samples = [
      { metric: 'rowReads', value: Number.MAX_SAFE_INTEGER, window: 'day' as const },
      { metric: 'rowWrites', value: Number.MAX_SAFE_INTEGER, window: 'day' as const },
      { metric: 'storageBytes', value: Number.MAX_SAFE_INTEGER, window: 'cycle' as const },
    ];
    expect(d1Module.evaluate(samples, cfg)).toHaveLength(samples.length);
  });
});

describe('storage query windows', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  /** Storage is a gauge: a max taken across the whole cycle reports a peak that
   *  may already have been freed, killing on usage that no longer exists. */
  it('queries storage over a recent window, not the whole billing cycle', async () => {
    vi.mocked(fetch).mockImplementation(
      gqlReply({
        kvOperationsAdaptiveGroups: [],
        kvStorageAdaptiveGroups: [{ max: { byteCount: 1 }, dimensions: { namespaceId: 'n' } }],
      }),
    );

    // A cycle opening on the 1st would make a cycle-anchored window start then.
    await kvModule.fetchUsage(env, { ...cfg, billingCycleDay: 1 });

    const storageCall = vi
      .mocked(fetch)
      .mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as { query: string; variables: { start: string } })
      .find((b) => b.query.includes('kvStorageAdaptiveGroups'));

    expect(storageCall).toBeDefined();
    const start = new Date(`${storageCall?.variables.start ?? ''}T00:00:00Z`);
    const ageDays = (Date.now() - start.getTime()) / 86_400_000;
    expect(ageDays).toBeLessThan(4);
  });
});
