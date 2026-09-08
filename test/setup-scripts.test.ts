import { describe, it, expect } from 'vitest';
import setupSh from '../setup.sh?raw';
import setupPs1 from '../setup.ps1?raw';
import configTs from '../src/config.example.ts?raw';

// setup.sh / setup.ps1 seed src/config.ts from src/config.example.ts and then
// rewrite it with regex anchors rather than literal defaults. A renamed config
// field does not make them fail — the substitution just silently no-ops and the
// operator's answers are dropped, which is how the C2 defaults regression went
// unnoticed. These tests run each anchor against the example the scripts copy
// from, so a rename breaks the build instead.
const ANCHORS: Array<{ field: string; pattern: RegExp }> = [
  { field: 'scope', pattern: /scope: '(?:zone|account|none)'/ },
  { field: 'billingCycleDay', pattern: /billingCycleDay: \d+/ },
  { field: 'autoResetOnBillingCycle', pattern: /autoResetOnBillingCycle: (?:true|false)/ },
  { field: 'enableRecoveryWebhook', pattern: /enableRecoveryWebhook: (?:true|false)/ },
  {
    field: 'blocking.workers',
    pattern: /workers: (?:'all'(?: as 'all' \| string\[\])?|\[[^\]]*\](?: as string\[\])?),/,
  },
  {
    field: 'blocking.pages',
    pattern: /pages: (?:'all'(?: as 'all' \| string\[\])?|\[[^\]]*\](?: as string\[\])?),/,
  },
];

describe('setup script config.ts anchors', () => {
  for (const { field, pattern } of ANCHORS) {
    it(`still matches ${field} in src/config.example.ts`, () => {
      expect(configTs).toMatch(pattern);
    });

    it(`is referenced by both setup scripts for ${field}`, () => {
      const source = pattern.source;
      expect(setupSh.includes(source) || setupSh.includes(field)).toBe(true);
      expect(setupPs1.includes(source) || setupPs1.includes(field)).toBe(true);
    });
  }

  it('no longer references the removed autoResetOnFirstOfMonth field', () => {
    for (const script of [setupSh, setupPs1, configTs]) {
      expect(script).not.toContain('autoResetOnFirstOfMonth');
    }
  });
});
