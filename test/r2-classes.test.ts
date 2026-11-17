import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { r2Module } from '../src/metrics/r2.js';
import { fetchModuleUsage } from '../src/metrics/collect.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const cfg: AppConfig = { ...CONFIG, billingCycleDay: 1 };

async function run(ops: Record<string, number>) {
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                {
                  r2OperationsAdaptiveGroups: Object.entries(ops).map(([actionType, requests]) => ({
                    sum: { requests },
                    dimensions: { actionType },
                  })),
                  r2StorageAdaptiveGroups: [
                    { max: { payloadSize: 1 }, dimensions: { bucketName: 'b' } },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    ),
  );
  const samples = await fetchModuleUsage(env, cfg, r2Module);
  const get = (m: string) => samples.find((s) => s.metric === m)!.value;
  return { a: get('classAOps'), b: get('classBOps') };
}

describe('r2 operation classes', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it('does not count or warn on free operations', async () => {
    const r = await run({
      DeleteObject: 5,
      DeleteBucket: 2,
      AbortMultipartUpload: 3,
      DeleteObjects: 7,
    });
    expect(r).toEqual({ a: 0, b: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts an unknown operation as Class A and warns', async () => {
    const r = await run({ BrandNewOperation: 42 });
    expect(r).toEqual({ a: 42, b: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BrandNewOperation'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('42'));
  });

  it('counts list operations as Class A', async () => {
    const r = await run({ ListObjects: 10, ListObjectsV2: 4, ListBuckets: 1 });
    expect(r).toEqual({ a: 15, b: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts reads and metadata lookups as Class B', async () => {
    const r = await run({ GetObject: 100, HeadBucket: 3, GetBucketCors: 2, UsageSummary: 1 });
    expect(r).toEqual({ a: 0, b: 106 });
    expect(warn).not.toHaveBeenCalled();
  });
});
