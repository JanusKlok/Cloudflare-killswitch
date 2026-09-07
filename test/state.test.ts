import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { readState, writeActive, writeKilled, shouldAutoReset } from '../src/state.js';
import { billingPeriodStart, isValidBillingCycleDay } from '../src/billing.js';
import type { AppConfig } from '../src/types.js';
import { CONFIG } from '../src/config.js';
import type { KvState } from '../src/types.js';

describe('readState', () => {
  it('returns active when KV is empty', async () => {
    const state = await readState(env);
    expect(state.status).toBe('active');
  });

  it('returns parsed state after a write', async () => {
    await writeKilled(env, {
      reason: 'test breach',
      wafRuleId: 'rule-1',
      wafRulesetId: 'ruleset-1',
    });
    const state = await readState(env);
    expect(state.status).toBe('killed');
    expect(state.reason).toBe('test breach');
    expect(state.wafRuleId).toBe('rule-1');
    expect(state.wafRulesetId).toBe('ruleset-1');
  });

  it('returns active after writeActive', async () => {
    await writeKilled(env, { reason: 'x', wafRuleId: 'r', wafRulesetId: 'rs' });
    await writeActive(env);
    const state = await readState(env);
    expect(state.status).toBe('active');
  });

  it('returns active when KV contains corrupt JSON', async () => {
    await env.KILL_SWITCH_STATE.put('state', 'not-json');
    const state = await readState(env);
    expect(state.status).toBe('active');
  });
});

describe('readState — killedAt', () => {
  it('records the original kill time alongside the write time', async () => {
    await writeKilled(env, { reason: 'first' });
    const first = await readState(env);
    expect(first.killedAt).toBe(first.timestamp);

    // A later rewrite (partial restore, or the enrich-after-actions write)
    // must carry the original kill time forward, not restamp it.
    await new Promise((r) => setTimeout(r, 5));
    await writeKilled(env, { reason: 'rewritten', killedAt: first.killedAt });
    const second = await readState(env);
    expect(second.killedAt).toBe(first.killedAt);
    expect(second.timestamp).not.toBe(first.timestamp);
    await writeActive(env);
  });
});

describe('isValidBillingCycleDay', () => {
  it('accepts 1 through 31', () => {
    for (const d of [1, 15, 28, 31]) expect(isValidBillingCycleDay(d)).toBe(true);
  });

  it('rejects out-of-range, fractional and non-finite values', () => {
    for (const d of [0, -1, 32, 1.5, NaN, Infinity]) {
      expect(isValidBillingCycleDay(d)).toBe(false);
    }
  });
});

describe('billingPeriodStart', () => {
  const at = (iso: string) => new Date(iso);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it('day 1 reproduces calendar-month behaviour', () => {
    expect(iso(billingPeriodStart(at('2026-03-17T12:00:00Z'), 1))).toBe('2026-03-01');
    expect(iso(billingPeriodStart(at('2026-03-01T00:00:00Z'), 1))).toBe('2026-03-01');
  });

  it('opens on the anniversary once it has passed this month', () => {
    expect(iso(billingPeriodStart(at('2026-03-20T00:00:00Z'), 17))).toBe('2026-03-17');
    expect(iso(billingPeriodStart(at('2026-03-17T00:00:00Z'), 17))).toBe('2026-03-17');
  });

  it('falls back to the previous month before the anniversary', () => {
    expect(iso(billingPeriodStart(at('2026-03-05T00:00:00Z'), 17))).toBe('2026-02-17');
  });

  it('clamps a 31st cycle to the last day of shorter months', () => {
    expect(iso(billingPeriodStart(at('2026-02-28T00:00:00Z'), 31))).toBe('2026-02-28');
    expect(iso(billingPeriodStart(at('2026-04-30T00:00:00Z'), 31))).toBe('2026-04-30');
    // 2028 is a leap year.
    expect(iso(billingPeriodStart(at('2028-02-29T00:00:00Z'), 31))).toBe('2028-02-29');
  });

  it('rolls back across a year boundary', () => {
    expect(iso(billingPeriodStart(at('2026-01-05T00:00:00Z'), 17))).toBe('2025-12-17');
  });

  it('never returns a start in the future', () => {
    for (const day of [1, 15, 28, 31]) {
      for (const month of [0, 1, 3, 11]) {
        const now = new Date(Date.UTC(2026, month, 14, 9, 30));
        expect(billingPeriodStart(now, day).getTime()).toBeLessThanOrEqual(now.getTime());
      }
    }
  });
});

describe('shouldAutoReset', () => {
  const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({
    ...CONFIG,
    autoResetOnBillingCycle: true,
    billingCycleDay: 17,
    ...over,
  });
  const killedOn = (iso: string): KvState => ({
    status: 'killed',
    timestamp: iso,
    killedAt: iso,
    wafRuleId: 'r',
    wafRulesetId: 'rs',
  });

  afterEach(() => vi.useRealTimers());

  /** Freeze the clock so these assertions hold on every calendar day. */
  function at(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  it('returns false when auto-reset is disabled', () => {
    at('2026-03-17T00:05:00Z');
    expect(shouldAutoReset(killedOn('2026-02-20T00:00:00Z'), cfg({ autoResetOnBillingCycle: false }))).toBe(false);
  });

  it('returns false when status is active', () => {
    at('2026-03-17T00:05:00Z');
    const state: KvState = { status: 'active', timestamp: '2026-02-20T00:00:00Z' };
    expect(shouldAutoReset(state, cfg())).toBe(false);
  });

  it('returns true once the billing anniversary has passed', () => {
    at('2026-03-17T00:05:00Z');
    expect(shouldAutoReset(killedOn('2026-03-10T00:00:00Z'), cfg())).toBe(true);
  });

  it('returns false for a kill inside the current billing period', () => {
    at('2026-03-20T00:05:00Z');
    expect(shouldAutoReset(killedOn('2026-03-18T00:00:00Z'), cfg())).toBe(false);
  });

  it('returns false before the anniversary even late in the calendar month', () => {
    at('2026-03-16T23:59:00Z');
    expect(shouldAutoReset(killedOn('2026-03-01T00:00:00Z'), cfg())).toBe(false);
  });

  it('still resets days after a missed anniversary — not gated on the exact day', () => {
    at('2026-03-25T00:05:00Z');
    expect(shouldAutoReset(killedOn('2026-02-25T00:00:00Z'), cfg())).toBe(true);
  });

  it('honours day 1 as calendar-month behaviour', () => {
    at('2026-03-01T00:05:00Z');
    expect(shouldAutoReset(killedOn('2026-02-14T00:00:00Z'), cfg({ billingCycleDay: 1 }))).toBe(true);
    expect(shouldAutoReset(killedOn('2026-03-01T00:01:00Z'), cfg({ billingCycleDay: 1 }))).toBe(false);
  });

  it('refuses to reset on an invalid billingCycleDay rather than guessing', () => {
    at('2026-03-17T00:05:00Z');
    expect(shouldAutoReset(killedOn('2026-01-01T00:00:00Z'), cfg({ billingCycleDay: 0 }))).toBe(false);
    expect(shouldAutoReset(killedOn('2026-01-01T00:00:00Z'), cfg({ billingCycleDay: 32 }))).toBe(false);
  });

  it('fails open on an unparseable kill time — the next tick re-kills if still over', () => {
    at('2026-03-17T00:05:00Z');
    const state: KvState = { status: 'killed', timestamp: 'not-a-date', killedAt: 'not-a-date' };
    expect(shouldAutoReset(state, cfg())).toBe(true);
  });

  it('falls back to timestamp for states written before killedAt existed', () => {
    at('2026-03-17T00:05:00Z');
    const legacy: KvState = { status: 'killed', timestamp: '2026-02-20T00:00:00Z' };
    expect(shouldAutoReset(legacy, cfg())).toBe(true);
  });
});
