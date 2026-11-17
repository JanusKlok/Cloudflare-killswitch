import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { MODULES } from '../src/metrics/index.js';
import { build, collectUsage } from '../src/metrics/collect.js';
import { evaluateSample } from '../src/metrics/evaluate.js';
import { CONFIG } from '../src/config.js';
import type { MetricSample } from '../src/types.js';

describe('metrics registry', () => {
  it('contains all 5 service modules', () => {
    const names = MODULES.map((m) => m.name);
    expect(names).toContain('workers');
    expect(names).toContain('pages');
    expect(names).toContain('kv');
    expect(names).toContain('r2');
    expect(names).toContain('d1');
    expect(names).toHaveLength(5);
  });

  it('each module exports query, parse and evaluate functions', () => {
    for (const mod of MODULES) {
      expect(typeof mod.query).toBe('function');
      expect(typeof mod.parse).toBe('function');
      expect(typeof mod.evaluate).toBe('function');
    }
  });
});

describe('evaluateSample', () => {
  const daySample = (value: number): MetricSample => ({ metric: 'requests', value, window: 'day' });

  it('returns empty when under blockAt', () => {
    expect(evaluateSample('w', daySample(50_000), { blockAt: 100_000 })).toHaveLength(0);
  });

  it('returns block breach when at blockAt', () => {
    const breaches = evaluateSample('w', daySample(100_000), { blockAt: 100_000 });
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.severity).toBe('block');
    expect(breaches[0]?.limit).toBe(100_000);
  });

  it('returns purge breach when at purgeAt', () => {
    const breaches = evaluateSample('w', daySample(110_000), {
      blockAt: 100_000,
      purgeAt: 110_000,
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.severity).toBe('purge');
    expect(breaches[0]?.limit).toBe(110_000);
  });

  it('returns block breach when over blockAt but below purgeAt', () => {
    const breaches = evaluateSample('w', daySample(105_000), {
      blockAt: 100_000,
      purgeAt: 110_000,
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.severity).toBe('block');
  });

  it('returns empty when threshold is undefined', () => {
    expect(evaluateSample('w', daySample(999_999), undefined)).toHaveLength(0);
  });
});

describe('merged query', () => {
  const cfg = { ...CONFIG, billingCycleDay: 1 };

  it('has no response key or variable claimed by two modules', () => {
    // build() throws on a collision; this guards every future module.
    expect(() =>
      build(
        env,
        MODULES.map((mod) => ({ mod, query: mod.query(cfg) })),
      ),
    ).not.toThrow();
  });

  it('is a single request for all modules', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }), { status: 200 }),
        ),
      ),
    );
    await collectUsage(env, cfg, MODULES);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
