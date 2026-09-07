import type { AppConfig, Env, KvState } from './types.js';
import { billingPeriodStart, isValidBillingCycleDay } from './billing.js';

const KV_KEY = 'state';

/** Built per call: a shared module-scope object would hand every caller the
 *  same mutable instance stamped at isolate boot. */
function activeState(): KvState {
  return { status: 'active', timestamp: new Date().toISOString() };
}

export async function readState(env: Env): Promise<KvState> {
  const raw = await env.KILL_SWITCH_STATE.get(KV_KEY);
  if (!raw) return activeState();
  try {
    return JSON.parse(raw) as KvState;
  } catch {
    return activeState();
  }
}

export async function writeKilled(
  env: Env,
  opts: {
    reason: string;
    /** The original kill time.  Callers rewriting an existing killed state
     *  (partial restore, or the enrich-after-actions write) must pass the
     *  value they read, or the auto-reset anchor moves into the current
     *  billing period and suppresses recovery until the next one. */
    killedAt?: string;
    // Optional: a partial-restore remnant may have removed the WAF rule already.
    wafRuleId?: string;
    wafRulesetId?: string;
    disabledWorkerScripts?: string[];
    blockedPagesProjects?: KvState['blockedPagesProjects'];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const state: KvState = {
    status: 'killed',
    timestamp: now,
    killedAt: opts.killedAt ?? now,
    reason: opts.reason,
  };
  if (opts.wafRuleId) state.wafRuleId = opts.wafRuleId;
  if (opts.wafRulesetId) state.wafRulesetId = opts.wafRulesetId;
  if (opts.disabledWorkerScripts?.length) state.disabledWorkerScripts = opts.disabledWorkerScripts;
  if (opts.blockedPagesProjects?.length) state.blockedPagesProjects = opts.blockedPagesProjects;
  await env.KILL_SWITCH_STATE.put(KV_KEY, JSON.stringify(state));
}

export async function writeActive(env: Env): Promise<void> {
  await env.KILL_SWITCH_STATE.put(KV_KEY, JSON.stringify(activeState()));
}

/** The kill time to compare against the billing period.  Falls back to
 *  `timestamp` for states written before `killedAt` existed. */
export function killTimeOf(state: KvState): string {
  return state.killedAt ?? state.timestamp;
}

/** True when the kill predates the current billing period, i.e. the quota that
 *  triggered it has since reset.  Deliberately not gated on "today is the
 *  anniversary": it fires on the first tick at or after the boundary, so a
 *  Worker that was down for the whole anniversary day still recovers. */
export function shouldAutoReset(state: KvState, cfg: AppConfig): boolean {
  if (!cfg.autoResetOnBillingCycle) return false;
  if (state.status !== 'killed') return false;

  if (!isValidBillingCycleDay(cfg.billingCycleDay)) {
    console.error(
      `autoResetOnBillingCycle is enabled but billingCycleDay (${String(cfg.billingCycleDay)}) is not an integer 1-31 — skipping auto-reset`,
    );
    return false;
  }

  const killedAt = new Date(killTimeOf(state));
  if (Number.isNaN(killedAt.getTime())) {
    // The kill time is unreadable, so it cannot be placed in a billing period.
    // Restoring is the self-correcting choice: the next tick re-reads usage and
    // re-kills if it is still over limit, whereas refusing to reset would strand
    // the account with no automated way back.
    console.error(`state kill time "${killTimeOf(state)}" is unparseable — allowing auto-reset`);
    return true;
  }

  return killedAt < billingPeriodStart(new Date(), cfg.billingCycleDay);
}
