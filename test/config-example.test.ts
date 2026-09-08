import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/config.example.js';

// src/config.example.ts is what an operator copies to src/config.ts, so its
// defaults are what an unattended or half-finished setup ends up running.
// A local setup run once leaked an operator's own (far more destructive)
// choices into a commit, back when config.ts itself was tracked; config.ts is
// untracked now, and these assertions keep the file it is seeded from safe.
describe('shipped config.example.ts defaults', () => {
  it("defaults scope to 'zone'", () => {
    expect(CONFIG.scope).toBe('zone');
  });

  it('takes no action on Workers scripts or Pages projects until opted in', () => {
    expect(CONFIG.blocking.workers).toEqual([]);
    expect(CONFIG.blocking.pages).toEqual([]);
  });

  it('opts out of destructive purge', () => {
    expect(CONFIG.purgeConfig.r2).toEqual([]);
    expect(CONFIG.purgeConfig.d1).toEqual([]);
    const thresholds = Object.values(CONFIG.limits).flatMap((m) => Object.values(m));
    expect(thresholds.every((t) => t.purgeAt === undefined)).toBe(true);
  });
});
