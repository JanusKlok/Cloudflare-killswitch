import type { AppConfig, Env, KvState } from './types.js';
import { writeActive, writeKilled } from './state.js';
import { removeBlockRule } from './actions/waf.js';
import { enableWorkers } from './actions/block-workers.js';
import { restorePages, type BlockedPage } from './actions/block-pages.js';

export interface RestoreResult {
  fullyRestored: boolean;
  errors: string[];
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

  const pagesPromise: Promise<BlockedPage[]> = state.blockedPagesProjects?.length
    ? restorePages(env, state.blockedPagesProjects).catch((err: unknown) => {
        errors.push(`restore-pages: ${String(err)}`);
        return state.blockedPagesProjects ?? [];
      })
    : Promise.resolve([]);

  const workersPromise: Promise<string[]> = state.disabledWorkerScripts?.length
    ? enableWorkers(env, state.disabledWorkerScripts).catch((err: unknown) => {
        errors.push(`enable-workers: ${String(err)}`);
        return state.disabledWorkerScripts ?? [];
      })
    : Promise.resolve([]);

  const wafPromise: Promise<boolean> =
    state.wafRuleId && state.wafRulesetId
      ? removeBlockRule(env, cfg, state.wafRuleId, state.wafRulesetId)
          .then(() => true)
          .catch((err: unknown) => {
            errors.push(`remove-waf-rule: ${String(err)}`);
            return false;
          })
      : Promise.resolve(true);

  const [failedPages, failedWorkers, wafRemoved] = await Promise.all([
    pagesPromise,
    workersPromise,
    wafPromise,
  ]);

  if (failedPages.length) {
    errors.push(`pages not restored: ${failedPages.map((p) => p.project).join(', ')}`);
  }
  if (failedWorkers.length) {
    errors.push(`workers not re-enabled: ${failedWorkers.join(', ')}`);
  }

  if (wafRemoved && failedPages.length === 0 && failedWorkers.length === 0) {
    await writeActive(env);
    return { fullyRestored: true, errors: [] };
  }

  await writeKilled(env, {
    reason: `partial restore failure — retry restore (was: ${state.reason ?? 'unknown'})`,
    wafRuleId: wafRemoved ? undefined : state.wafRuleId,
    wafRulesetId: wafRemoved ? undefined : state.wafRulesetId,
    disabledWorkerScripts: failedWorkers,
    blockedPagesProjects: failedPages,
  });
  return { fullyRestored: false, errors };
}
