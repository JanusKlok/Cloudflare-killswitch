import { describe, it, expect } from 'vitest';
import { MODULES } from '../src/metrics/index.js';
import { evaluateSample } from '../src/metrics/evaluate.js';
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

  it('each module exports fetchUsage and evaluate functions', () => {
    for (const mod of MODULES) {
      expect(typeof mod.fetchUsage).toBe('function');
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
    const breaches = evaluateSample('w', daySample(110_000), { blockAt: 100_000, purgeAt: 110_000 });
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.severity).toBe('purge');
    expect(breaches[0]?.limit).toBe(110_000);
  });

  it('returns block breach when over blockAt but below purgeAt', () => {
    const breaches = evaluateSample('w', daySample(105_000), { blockAt: 100_000, purgeAt: 110_000 });
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.severity).toBe('block');
  });

  it('returns empty when threshold is undefined', () => {
    expect(evaluateSample('w', daySample(999_999), undefined)).toHaveLength(0);
  });
});
