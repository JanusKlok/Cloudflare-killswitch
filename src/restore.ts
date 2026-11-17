import type { AppConfig, Env, KvState, R2BucketRecord } from './types.js';
import {
  isRestoreRemnant,
  killedStateOf,
  killTimeOf,
  stateFingerprint,
  writeActive,
  writeKilled,
  type KilledFields,
} from './state.js';

const REMNANT_PREFIX = 'partial restore failure';
import { removeBlockRule } from './actions/waf.js';
import { enableWorkers, workerScriptName, type RecordedWorker } from './actions/block-workers.js';
import { restorePages, type BlockedPage } from './actions/block-pages.js';
import { restoreR2PublicAccess } from './actions/block-r2.js';

export interface RestoreResult {
  fullyRestored: boolean;
  errors: string[];
  /** Things the operator should know that are not failures (e.g. buckets left
   *  private on purpose). */
  notes: string[];
  /** False when a partial restore left exactly the remnant it started from:
   *  nothing was written and callers should not alert again. */
  changed: boolean;
}

/** Undoes every kill action recorded in `state` and persists the outcome.
 *  Actions run concurrently — they touch independent resources, so a Pages
 *  failure shouldn't delay WAF removal.  Only what actually succeeded is
 *  cleared: on partial failure the state stays 'killed' holding just the
 *  failed remnants, so a later restore attempt retries exactly those. */
export async function restoreFromState(
  env: Env,
  cfg: AppConfig,
  state: KvState,
): Promise<RestoreResult> {
  const errors: string[] = [];
  const notes: string[] = [];

  const pagesPromise: Promise<BlockedPage[]> = state.blockedPagesProjects?.length
    ? restorePages(env, state.blockedPagesProjects).catch((err: unknown) => {
        errors.push(`restore-pages: ${String(err)}`);
        return state.blockedPagesProjects ?? [];
      })
    : Promise.resolve([]);

  const workersPromise: Promise<RecordedWorker[]> = state.disabledWorkerScripts?.length
    ? enableWorkers(env, state.disabledWorkerScripts).catch((err: unknown) => {
        errors.push(`enable-workers: ${String(err)}`);
        return state.disabledWorkerScripts ?? [];
      })
    : Promise.resolve([]);

  const r2Promise: Promise<R2BucketRecord[]> = state.blockedR2Buckets?.length
    ? restoreR2PublicAccess(env, state.blockedR2Buckets)
        .then(({ failed, skipped }) => {
          if (skipped.length > 0) {
            notes.push(
              `R2 r2.dev URLs left OFF (state before the kill was unknown) — re-enable by hand if they were public: ${skipped.map((b) => b.bucket).join(', ')}`,
            );
          }
          return failed;
        })
        .catch((err: unknown) => {
          errors.push(`restore-r2: ${String(err)}`);
          return state.blockedR2Buckets ?? [];
        })
    : Promise.resolve([]);

  // Both ids are required to address the rule. A state holding one without the
  // other cannot be acted on, so say so loudly instead of silently reporting a
  // full restore while the rule stays live and blocks all traffic.
  if (Boolean(state.wafRuleId) !== Boolean(state.wafRulesetId)) {
    const detail = state.wafRuleId
      ? `rule ${state.wafRuleId} has no recorded ruleset id`
      : `ruleset ${state.wafRulesetId ?? '(unknown)'} has no recorded rule id`;
    console.error(`restore: incomplete WAF reference — ${detail}; remove it in the dashboard`);
    errors.push(`remove-waf-rule: incomplete reference (${detail})`);
  }

  const wafPromise: Promise<boolean> =
    state.wafRuleId && state.wafRulesetId
      ? removeBlockRule(env, cfg, state.wafRuleId, state.wafRulesetId)
          .then(() => true)
          .catch((err: unknown) => {
            errors.push(`remove-waf-rule: ${String(err)}`);
            return false;
          })
      : Promise.resolve(false);

  const hadWafRule = Boolean(state.wafRuleId) || Boolean(state.wafRulesetId);
  const [failedPages, failedWorkers, wafDeleted, failedR2] = await Promise.all([
    pagesPromise,
    workersPromise,
    wafPromise,
    r2Promise,
  ]);
  // Nothing recorded means nothing to undo, which is a success, not a failure.
  const wafRemoved = hadWafRule ? wafDeleted : true;

  if (failedPages.length) {
    errors.push(`pages not restored: ${failedPages.map((p) => p.project).join(', ')}`);
  }
  if (failedWorkers.length) {
    errors.push(`workers not re-enabled: ${failedWorkers.map(workerScriptName).join(', ')}`);
  }

  if (failedR2.length) {
    errors.push(`r2 not re-enabled: ${failedR2.map((b) => b.bucket).join(', ')}`);
  }
  for (const note of notes) console.warn(`restore: ${note}`);

  if (
    wafRemoved &&
    failedPages.length === 0 &&
    failedWorkers.length === 0 &&
    failedR2.length === 0
  ) {
    await writeActive(env);
    return { fullyRestored: true, errors: [], notes, changed: true };
  }

  const remnant: KilledFields = {
    // Not re-wrapped on every retry, or the reason would grow without bound.
    reason: isRestoreRemnant(state)
      ? (state.reason ?? REMNANT_PREFIX)
      : `${REMNANT_PREFIX} — retry restore (was: ${state.reason ?? 'unknown'})`,
    // Marks this state as "being restored", not "being killed": a killed tick
    // must retry the restore instead of re-blocking what was already undone.
    restorePending: true,
    // Keep the original kill time: restamping it would push the auto-reset
    // anchor into the current billing period, so a failed reset on the
    // anniversary would suppress every further attempt until the next one.
    killedAt: killTimeOf(state),
    wafRuleId: wafRemoved ? undefined : state.wafRuleId,
    wafRulesetId: wafRemoved ? undefined : state.wafRulesetId,
    disabledWorkerScripts: failedWorkers,
    blockedPagesProjects: failedPages,
    // Carried over like killedAt: dropping resetWindow would turn a 'day' kill
    // into a 'cycle' one, and dropping purgedServices would let a killed tick
    // purge again (or, for a v2.0.0 state, mark it as safe to purge).
    resetWindow: state.resetWindow,
    purgedServices: state.purgedServices,
    pendingWorkerBlocks: state.pendingWorkerBlocks?.filter((s) =>
      failedWorkers.some((w) => workerScriptName(w) === s),
    ),
    pendingPagesBlocks: state.pendingPagesBlocks?.filter((p) =>
      failedPages.some((f) => f.project === p),
    ),
    blockedR2Buckets: failedR2,
    pendingR2Blocks: state.pendingR2Blocks?.filter((b) => failedR2.some((f) => f.bucket === b)),
  };
  // A retry that fails on exactly the same items changes nothing; skipping the
  // write saves the KV budget (1,000 writes/day) on a remnant retried every tick.
  if (stateFingerprint(killedStateOf(remnant, '')) === stateFingerprint(state)) {
    return { fullyRestored: false, errors, notes, changed: false };
  }
  await writeKilled(env, remnant);
  return { fullyRestored: false, errors, notes, changed: true };
}
