import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/config.js';

// The setup scripts rewrite src/config.ts in place, so a local setup run can
// leak an operator's own (far more destructive) choices into a commit — it
// happened once already. These assertions pin the shipped defaults to the safe
// values the README documents so that regression cannot land silently again.
describe('shipped config.ts defaults', () => {
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
