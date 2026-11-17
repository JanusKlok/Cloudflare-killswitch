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

/** Everything a killed state records, minus the fields writeKilled stamps. */
export type KilledFields = Omit<KvState, 'status' | 'timestamp' | 'killedAt' | 'reason'> & {
  reason: string;
  /** The original kill time.  Callers rewriting an existing killed state
   *  (partial restore, or the enrich-after-actions write) must pass the
   *  value they read, or the auto-reset anchor moves into the current
   *  billing period and suppresses recovery until the next one. */
  killedAt?: string;
};

/** Builds the exact record writeKilled persists: unset fields and empty lists
 *  are dropped so a state read back and rebuilt compares equal to itself.
 *  `purgedServices` is the exception — an empty list is meaningful, because its
 *  absence marks a v2.0.0 state that must never purge on a later tick. */
export function killedStateOf(opts: KilledFields, timestamp: string): KvState {
  const state: KvState = {
    status: 'killed',
    timestamp,
    killedAt: opts.killedAt ?? timestamp,
    reason: opts.reason,
  };
  if (opts.wafRuleId) state.wafRuleId = opts.wafRuleId;
  if (opts.wafRulesetId) state.wafRulesetId = opts.wafRulesetId;
  if (opts.disabledWorkerScripts?.length) state.disabledWorkerScripts = opts.disabledWorkerScripts;
  if (opts.blockedPagesProjects?.length) state.blockedPagesProjects = opts.blockedPagesProjects;
  if (opts.resetWindow) state.resetWindow = opts.resetWindow;
  if (opts.purgedServices) state.purgedServices = opts.purgedServices;
  if (opts.pendingWorkerBlocks?.length) state.pendingWorkerBlocks = opts.pendingWorkerBlocks;
  if (opts.pendingPagesBlocks?.length) state.pendingPagesBlocks = opts.pendingPagesBlocks;
  if (opts.blockedR2Buckets?.length) state.blockedR2Buckets = opts.blockedR2Buckets;
  if (opts.restorePending) state.restorePending = true;
  if (opts.pendingR2Blocks?.length) state.pendingR2Blocks = opts.pendingR2Blocks;
  return state;
}

/** Content identity of a killed state, ignoring the write timestamp.  A killed
 *  tick compares fingerprints before writing: the Free plan allows 1,000 KV
 *  writes/day, and this Worker monitors that very metric. */
export function stateFingerprint(state: KvState): string {
  return JSON.stringify({ ...state, timestamp: undefined });
}

export async function writeKilled(env: Env, opts: KilledFields): Promise<void> {
  const state = killedStateOf(opts, new Date().toISOString());
  await env.KILL_SWITCH_STATE.put(KV_KEY, JSON.stringify(state));
}

export async function writeActive(env: Env): Promise<void> {
  await env.KILL_SWITCH_STATE.put(KV_KEY, JSON.stringify(activeState()));
}

/** True for a killed state left behind by a partly failed restore: what it
 *  records still has to be undone, and nothing else should be blocked.
 *  v2.0.0 remnants carry no marker, only the reason prefix. */
export function isRestoreRemnant(state: KvState): boolean {
  return (
    state.status === 'killed' &&
    (state.restorePending === true || (state.reason ?? '').startsWith('partial restore failure'))
  );
}

/** The kill time to compare against the billing period.  Falls back to
 *  `timestamp` for states written before `killedAt` existed. */
export function killTimeOf(state: KvState): string {
  return state.killedAt ?? state.timestamp;
}

/** True when the quota that triggered the kill has since reset, and auto-reset
 *  is enabled.  Only the clock: callers must also check that nothing is still
 *  breaching before they actually restore.
 *
 *  A 'day' kill is due once the kill predates today's 00:00 UTC (when
 *  Cloudflare's daily quotas roll over); a 'cycle' kill — and any state without
 *  `resetWindow`, i.e. written by v2.0.0 — once it predates the billing period.
 *  Neither is gated on "today is the boundary": it fires on the first tick at or
 *  after it, so a Worker that was down across the boundary still recovers. */
export function shouldAutoReset(state: KvState, cfg: AppConfig): boolean {
  if (!cfg.autoResetOnBillingCycle) return false;
  if (state.status !== 'killed') return false;

  const killedAt = new Date(killTimeOf(state));
  const now = new Date();

  if (state.resetWindow === 'day') {
    if (Number.isNaN(killedAt.getTime())) return unparseableKillTime(state);
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return killedAt < dayStart;
  }

  if (!isValidBillingCycleDay(cfg.billingCycleDay)) {
    console.error(
      `autoResetOnBillingCycle is enabled but billingCycleDay (${String(cfg.billingCycleDay)}) is not an integer 1-31 — skipping auto-reset`,
    );
    return false;
  }

  if (Number.isNaN(killedAt.getTime())) return unparseableKillTime(state);

  return killedAt < billingPeriodStart(now, cfg.billingCycleDay);
}

/** The kill time cannot be placed in any period.  Restoring is the
 *  self-correcting choice: the next tick re-reads usage and re-kills if it is
 *  still over limit, whereas refusing to reset would strand the account with no
 *  automated way back. */
function unparseableKillTime(state: KvState): boolean {
  console.error(`state kill time "${killTimeOf(state)}" is unparseable — allowing auto-reset`);
  return true;
}
