import type {
  AppConfig,
  Breach,
  Env,
  KvState,
  R2BucketRecord,
  WorkerSubdomainRecord,
} from './types.js';
import {
  killedStateOf,
  isRestoreRemnant,
  killTimeOf,
  readState,
  shouldAutoReset,
  stateFingerprint,
  writeKilled,
  type KilledFields,
} from './state.js';
import { restoreFromState } from './restore.js';
import { MODULES } from './metrics/index.js';
import { collectUsage, type ModuleOutcome } from './metrics/collect.js';
import { evaluateCombined } from './metrics/combined.js';
import { deployBlockRule } from './actions/waf.js';
import {
  disableWorkers,
  mergeWorkerRecords,
  resolveWorkerTargets,
  workerScriptName,
} from './actions/block-workers.js';
import { blockPages, resolvePageTargets, type PageTarget } from './actions/block-pages.js';
import { disableR2PublicAccess, mergeR2Records, resolveR2Targets } from './actions/block-r2.js';
import { sendAlerts, shouldAlertMetricFailure } from './alerts.js';
import { purgeR2 } from './actions/purge-r2.js';
import { purgeD1 } from './actions/purge-d1.js';
import type { PurgeResult } from './actions/purge-r2.js';
import type { D1PurgeResult } from './actions/purge-d1.js';

// Binary units, because the configured limits are binary: Cloudflare's "1 GB"
// KV allowance is 1_073_741_824 bytes. Dividing by 1e9 rendered that as
// "1.07 GB", which reads like the limit had been exceeded.
const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

function formatBytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(2)} GiB`;
  if (n >= MIB) return `${(n / MIB).toFixed(2)} MiB`;
  if (n >= KIB) return `${(n / KIB).toFixed(2)} KiB`;
  return `${n} B`;
}

function formatValue(metric: string, value: number): string {
  if (metric.toLowerCase().includes('bytes')) return formatBytes(value);
  return value.toLocaleString('en-US');
}

const WINDOW_LABEL: Record<Breach['window'], string> = {
  day: 'per day',
  cycle: 'per billing cycle',
};

function breachSummary(breaches: Breach[]): string {
  return breaches
    .map(
      (b) =>
        `  - ${b.service}.${b.metric} (${WINDOW_LABEL[b.window]}): ` +
        `${formatValue(b.metric, b.observed)} observed, ` +
        `limit ${formatValue(b.metric, b.limit)} [${b.severity.toUpperCase()}]`,
    )
    .join('\n');
}

/** The single exit for every alert (email and webhook).  Never throws: a
 *  failed alert must not abort a tick that has already recorded what it did,
 *  or the next tick would redo it. */
export async function notify(env: Env, subject: string, body: string): Promise<void> {
  try {
    await sendAlerts(env, subject, body);
  } catch (err) {
    console.error('alert failed:', err);
  }
}

interface Evaluation {
  breaches: Breach[];
  moduleErrors: string[];
}

/** Fetches usage for all modules in one GraphQL request (see metrics/collect.ts).
 *  Settle-style isolation: a single failing module never aborts the whole tick. */
async function evaluateUsage(env: Env, cfg: AppConfig): Promise<Evaluation> {
  const outcomes = await collectUsage(env, cfg, MODULES);

  const breaches: Breach[] = [];
  const moduleErrors: string[] = [];
  const byName: Record<string, ModuleOutcome | undefined> = {};
  MODULES.forEach((mod, i) => {
    const outcome = outcomes[i];
    byName[mod.name] = outcome;
    if (!outcome) return;
    if ('error' in outcome) {
      moduleErrors.push(`${mod.name}: ${outcome.error}`);
      return;
    }
    try {
      breaches.push(...mod.evaluate(outcome.samples, cfg));
    } catch (err) {
      moduleErrors.push(`${mod.name}: ${String(err)}`);
    }
  });

  const combined = evaluateCombined(byName, cfg);
  breaches.push(...combined.breaches);
  moduleErrors.push(...combined.errors);
  return { breaches, moduleErrors };
}

/** What one pass of ensureBlocked did, for the alert text. */
interface EnsureReport {
  wafDeployed: boolean;
  wafError?: string;
  workersRecorded: string[];
  workersBlocked: string[];
  workersFailed: string[];
  pagesRecorded: string[];
  pagesBlocked: string[];
  pagesFailed: string[];
  r2Recorded: string[];
  r2Blocked: string[];
  r2Failed: string[];
  purgedNow: string[];
  r2Results: PurgeResult[];
  d1Results: D1PurgeResult[];
}

function fieldsOf(state: KvState): KilledFields {
  const { status: _status, timestamp: _timestamp, ...rest } = state;
  return { ...rest, reason: state.reason ?? 'unknown', killedAt: killTimeOf(state) };
}

function fingerprintOf(state: KvState): string {
  return stateFingerprint(killedStateOf(fieldsOf(state), state.timestamp));
}

/** Brings the account to the "everything blocked" state recorded in `state`,
 *  mutating `state` and persisting it.  Shared by the first kill (a fresh state
 *  that has never been written) and every later killed tick, so both do the
 *  same work and only the inputs differ.
 *
 *  Idempotent by construction: it acts only on what `state` does not yet
 *  record (new targets) or still marks pending (failed blocks), and writes KV
 *  only when the state actually changed.
 *
 *  `persistedFingerprint` is the fingerprint of what KV holds now, or '' when
 *  nothing is written yet. */
async function ensureBlocked(
  env: Env,
  cfg: AppConfig,
  state: KvState,
  persistedFingerprint: string,
  breaches: Breach[],
): Promise<EnsureReport> {
  const report: EnsureReport = {
    wafDeployed: false,
    workersRecorded: [],
    workersBlocked: [],
    workersFailed: [],
    pagesRecorded: [],
    pagesBlocked: [],
    pagesFailed: [],
    r2Recorded: [],
    r2Blocked: [],
    r2Failed: [],
    purgedNow: [],
    r2Results: [],
    d1Results: [],
  };

  let persisted = persistedFingerprint;
  const persist = async (): Promise<void> => {
    const fingerprint = fingerprintOf(state);
    if (fingerprint === persisted) return;
    await writeKilled(env, fieldsOf(state));
    persisted = fingerprint;
  };

  // WAF first (bleeding stops first).  scope 'none' means there is no zone to
  // protect — blocking.workers/pages is the whole kill.
  if (cfg.scope !== 'none' && !(state.wafRuleId && state.wafRulesetId)) {
    try {
      // adoptExisting: if an earlier deploy succeeded but its response was
      // lost, reuse that rule instead of stacking a second one.
      const { ruleId, rulesetId } = await deployBlockRule(env, cfg, env.RECOVERY_HOSTNAME, {
        adoptExisting: true,
      });
      state.wafRuleId = ruleId;
      state.wafRulesetId = rulesetId;
      report.wafDeployed = true;
    } catch (err) {
      // A WAF failure must not abort the kill: blocking.workers/pages are
      // independent mitigations.  The next killed tick retries.
      console.error('waf deploy error:', err);
      report.wafError = `waf: ${String(err)}`;
    }
  }

  // Record the WAF rule immediately: an unrecorded rule would be orphaned
  // (never removable via /restore).  On the first kill this also records the
  // kill itself, even when the WAF deploy failed.
  await persist();

  // Resolve what we are about to touch BEFORE touching it.  These are
  // read-only calls, and recording their result first is what makes the kill
  // recoverable: if the isolate dies mid-kill, scripts would already be
  // disabled and Pages projects already serving the empty deployment with nothing in state to
  // undo them.  Targets already recorded are skipped before their per-item
  // GET: after the block they report the blocked state, not the original one.
  const knownWorkers = new Set((state.disabledWorkerScripts ?? []).map(workerScriptName));
  const knownPages = new Set((state.blockedPagesProjects ?? []).map((p) => p.project));
  const knownR2 = new Set((state.blockedR2Buckets ?? []).map((b) => b.bucket));
  const [freshWorkers, freshPages, freshR2] = await Promise.all([
    resolveWorkerTargets(env, cfg, knownWorkers).catch((err: unknown) => {
      console.error('resolve-worker-targets error:', err);
      return [] as WorkerSubdomainRecord[];
    }),
    resolvePageTargets(env, cfg, knownPages).catch((err: unknown) => {
      console.error('resolve-page-targets error:', err);
      return [] as PageTarget[];
    }),
    resolveR2Targets(env, cfg, knownR2).catch((err: unknown) => {
      console.error('resolve-r2-targets error:', err);
      return [] as R2BucketRecord[];
    }),
  ]);

  // The intent, not the outcome: restoring a subdomain that was never
  // disabled is a no-op, whereas omitting one that was leaves it dark forever.
  const newWorkers = freshWorkers.filter((w) => !knownWorkers.has(w.script));
  if (newWorkers.length > 0) {
    // mergeWorkerRecords keeps existing records winning, whatever a GET said.
    state.disabledWorkerScripts = mergeWorkerRecords(state.disabledWorkerScripts ?? [], newWorkers);
    report.workersRecorded = newWorkers.map((w) => w.script);
    state.pendingWorkerBlocks = [...(state.pendingWorkerBlocks ?? []), ...report.workersRecorded];
  }
  const newPages = freshPages.filter((p) => !knownPages.has(p.project));
  if (newPages.length > 0) {
    state.blockedPagesProjects = [
      ...(state.blockedPagesProjects ?? []),
      ...newPages.map(({ project, previousDeploymentId, productionBranch }) => ({
        project,
        previousDeploymentId,
        productionBranch,
      })),
    ];
    report.pagesRecorded = newPages.map((p) => p.project);
    state.pendingPagesBlocks = [...(state.pendingPagesBlocks ?? []), ...report.pagesRecorded];
  }
  const newR2 = freshR2.filter((b) => !knownR2.has(b.bucket));
  if (newR2.length > 0) {
    state.blockedR2Buckets = mergeR2Records(state.blockedR2Buckets ?? [], newR2);
    report.r2Recorded = newR2.map((b) => b.bucket);
    state.pendingR2Blocks = [...(state.pendingR2Blocks ?? []), ...report.r2Recorded];
  }
  await persist();

  // Now mutate: everything recorded-but-pending, i.e. this tick's new targets
  // plus earlier ones whose block failed.  All of it is already recorded.
  const workerTargets: WorkerSubdomainRecord[] = [];
  for (const name of state.pendingWorkerBlocks ?? []) {
    const entry = (state.disabledWorkerScripts ?? []).find((e) => workerScriptName(e) === name);
    if (entry === undefined) continue;
    workerTargets.push(
      typeof entry === 'string' ? { script: entry, enabled: true, previewsEnabled: false } : entry,
    );
  }
  const pageTargets: PageTarget[] = [];
  for (const project of state.pendingPagesBlocks ?? []) {
    const entry = (state.blockedPagesProjects ?? []).find((p) => p.project === project);
    if (entry?.productionBranch === undefined) {
      console.error(`block-pages: no recorded production branch for ${project} — cannot retry`);
      continue;
    }
    pageTargets.push({
      project,
      previousDeploymentId: entry.previousDeploymentId,
      productionBranch: entry.productionBranch,
    });
  }

  const r2Targets = (state.blockedR2Buckets ?? []).filter((b) =>
    (state.pendingR2Blocks ?? []).includes(b.bucket),
  );

  const [disabledWorkers, blockedPages, disabledR2] = await Promise.all([
    disableWorkers(env, workerTargets).catch((err: unknown) => {
      console.error('block-workers error:', err);
      return [] as WorkerSubdomainRecord[];
    }),
    blockPages(env, pageTargets).catch((err: unknown) => {
      console.error('block-pages error:', err);
      return [];
    }),
    disableR2PublicAccess(env, r2Targets).catch((err: unknown) => {
      console.error('block-r2 error:', err);
      return [] as R2BucketRecord[];
    }),
  ]);
  report.workersBlocked = disabledWorkers.map((w) => w.script);
  report.pagesBlocked = blockedPages.map((p) => p.project);
  state.pendingWorkerBlocks = (state.pendingWorkerBlocks ?? []).filter(
    (n) => !report.workersBlocked.includes(n),
  );
  state.pendingPagesBlocks = (state.pendingPagesBlocks ?? []).filter(
    (p) => !report.pagesBlocked.includes(p),
  );
  report.r2Blocked = disabledR2.map((b) => b.bucket);
  state.pendingR2Blocks = (state.pendingR2Blocks ?? []).filter(
    (b) => !report.r2Blocked.includes(b),
  );
  report.workersFailed = [...state.pendingWorkerBlocks];
  report.pagesFailed = [...state.pendingPagesBlocks];
  report.r2Failed = [...state.pendingR2Blocks];

  // Purge, scoped to the breaching service: purging deletes data permanently,
  // so an unrelated breach (e.g. a workers request spike) must never wipe R2
  // buckets or D1 tables.  Once per service per kill, and never for a state
  // without `purgedServices` (written by v2.0.0, which may already have purged).
  if (state.purgedServices !== undefined) {
    const done = state.purgedServices;
    const due = new Set(
      breaches
        .filter((b) => b.severity === 'purge' && (b.service === 'r2' || b.service === 'd1'))
        .map((b) => b.service)
        .filter((service) => !done.includes(service)),
    );
    if (due.has('r2')) {
      for (const target of cfg.purgeConfig.r2) {
        try {
          report.r2Results.push(await purgeR2(env, target));
        } catch (err) {
          report.r2Results.push({
            bindingName: target.bindingName,
            deleted: 0,
            errors: [String(err)],
          });
        }
      }
    }
    if (due.has('d1')) {
      for (const target of cfg.purgeConfig.d1) {
        try {
          report.d1Results.push(await purgeD1(env, target));
        } catch (err) {
          report.d1Results.push({
            bindingName: target.bindingName,
            tableResults: [{ table: '(all)', action: 'purge', success: false, error: String(err) }],
          });
        }
      }
    }
    // Recorded after the run, whatever its outcome: a failed purge is not
    // retried (re-running a destructive action unattended is the worse risk),
    // while an isolate that dies mid-purge never gets here and so finishes it.
    report.purgedNow = [...due];
    if (report.purgedNow.length > 0) state.purgedServices = [...done, ...report.purgedNow];
  }
  await persist();

  return report;
}

function purgeLines(report: EnsureReport): string[] {
  const lines: string[] = [];
  if (report.r2Results.length > 0) {
    lines.push('', 'R2 purge results:');
    for (const r of report.r2Results) {
      lines.push(`  ${r.bindingName}: deleted ${r.deleted} object(s)`);
      if (r.errors.length) lines.push(`    errors: ${r.errors.join('; ')}`);
    }
  }
  if (report.d1Results.length > 0) {
    lines.push('', 'D1 purge results:');
    for (const r of report.d1Results) {
      for (const t of r.tableResults) {
        const status = t.success ? 'OK' : `FAILED: ${t.error}`;
        lines.push(`  ${r.bindingName}.${t.table} [${t.action}]: ${status}`);
      }
    }
  }
  return lines;
}

function blockLines(report: EnsureReport): string[] {
  const lines: string[] = [];
  if (report.workersBlocked.length > 0) {
    lines.push(
      '',
      `Workers disabled (${report.workersBlocked.length}): ${report.workersBlocked.join(', ')}`,
    );
  }
  if (report.pagesBlocked.length > 0) {
    lines.push(
      '',
      `Pages blocked (${report.pagesBlocked.length}): ${report.pagesBlocked.join(', ')}`,
    );
  }
  if (report.r2Blocked.length > 0) {
    lines.push(
      '',
      `R2 public r2.dev URLs disabled (${report.r2Blocked.length}): ${report.r2Blocked.join(', ')}`,
    );
  }
  if (report.r2Failed.length > 0) {
    lines.push(
      '',
      `R2 buckets that FAILED to block (${report.r2Failed.length}, retried every tick): ${report.r2Failed.join(', ')}`,
    );
  }
  if (report.workersFailed.length > 0) {
    lines.push(
      '',
      `Workers that FAILED to block (${report.workersFailed.length}, retried every tick): ${report.workersFailed.join(', ')}`,
    );
  }
  if (report.pagesFailed.length > 0) {
    lines.push(
      '',
      `Pages that FAILED to block (${report.pagesFailed.length}, retried every tick): ${report.pagesFailed.join(', ')}`,
    );
  }
  return lines;
}

async function firstKill(
  env: Env,
  cfg: AppConfig,
  { breaches, moduleErrors }: Evaluation,
): Promise<void> {
  const purgeBreaches = breaches.filter((b) => b.severity === 'purge');
  const blockBreaches = breaches.filter((b) => b.severity === 'block');
  const reason =
    purgeBreaches.length > 0
      ? `${purgeBreaches.length} purge breach(es), ${blockBreaches.length} block breach(es)`
      : `${blockBreaches.length} block breach(es)`;

  // One kill time, kept by every later write: restamping it would move the
  // auto-reset anchor into the current period.
  const killedAt = new Date().toISOString();
  const state: KvState = {
    status: 'killed',
    timestamp: killedAt,
    killedAt,
    reason,
    resetWindow: breaches.some((b) => b.window === 'cycle') ? 'cycle' : 'day',
    // Present from the start, even empty: it marks a state that may purge on later ticks.
    purgedServices: [],
  };

  const report = await ensureBlocked(env, cfg, state, '', breaches);

  const emailLines: string[] = [
    state.wafRuleId ? 'Kill Switch triggered. WAF block rule deployed.' : 'Kill Switch triggered.',
    '',
    'Breaches detected:',
    breachSummary(breaches),
  ];
  if (state.wafRuleId) {
    emailLines.push(
      '',
      `WAF rule ID : ${state.wafRuleId}`,
      `WAF ruleset : ${state.wafRulesetId}`,
      `Scope       : ${cfg.scope}`,
    );
  }
  emailLines.push(...blockLines(report), ...purgeLines(report));
  if (report.wafError) {
    emailLines.push(
      '',
      'WAF rule NOT deployed — traffic on the zone is still being served (retried every tick):',
      `  ${report.wafError}`,
    );
  }
  if (moduleErrors.length > 0) {
    emailLines.push(
      '',
      'Metric fetch errors (some services not checked):',
      ...moduleErrors.map((e) => `  ${e}`),
    );
  }
  if (cfg.enableRecoveryWebhook) {
    emailLines.push('', 'To restore: POST /restore with Authorization: Bearer <RECOVERY_SECRET>');
  }

  await notify(env, '[Kill Switch] Traffic blocked — limits breached', emailLines.join('\n'));
}

async function killedTick(
  env: Env,
  cfg: AppConfig,
  state: KvState,
  { breaches, moduleErrors }: Evaluation,
): Promise<void> {
  if (moduleErrors.length > 0) {
    console.error('Metric fetch errors:', moduleErrors.join('; '));
  }

  // A remnant of a partly failed restore (from /restore or an auto-reset) is
  // finished, not re-killed: re-blocking would undo everything that was
  // already restored.  Only a breach that exists right now re-arms the kill.
  // Otherwise reset only when due and nothing is breaching now — a ceiling
  // still exceeded would be restored and re-killed every period.  Errors alone
  // count as no breach, the same fail-open stance as an active tick.
  const remnant = isRestoreRemnant(state);
  if ((remnant || shouldAutoReset(state, cfg)) && breaches.length === 0) {
    const { fullyRestored, errors, notes, changed } = await restoreFromState(env, cfg, state);
    if (!fullyRestored) {
      // Remnants stay recorded in the killed state and are retried next tick.
      console.error('restore retry: partial restore failure:', errors.join('; '));
      // Alert only when the remnant changed, or a stuck item would alert every five minutes.
      if (changed) {
        await notify(
          env,
          '[Kill Switch] Restore partly failed',
          ['Some blocks could not be undone; retried every tick.', '', ...errors, ...notes].join(
            '\n',
          ),
        );
      }
      return;
    }
    await notify(
      env,
      remnant ? '[Kill Switch] Restore completed' : '[Kill Switch] Auto-reset — traffic restored',
      [
        remnant
          ? 'The remaining blocks from an earlier partial restore have been undone.'
          : 'The quota that caused the kill has reset and nothing is over a limit.',
        ...notes,
      ].join('\n'),
    );
    return;
  }
  if (shouldAutoReset(state, cfg)) {
    console.warn('auto-reset is due but usage is still over a limit — staying killed');
  }

  const persistedFingerprint = fingerprintOf(state);
  const current: KvState = { ...state };
  // A breach during a restore remnant re-arms the kill: block everything again.
  delete current.restorePending;
  const upgraded = state.resetWindow === 'day' && breaches.some((b) => b.window === 'cycle');
  if (upgraded) current.resetWindow = 'cycle';

  const report = await ensureBlocked(env, cfg, current, persistedFingerprint, breaches);

  // A target that keeps failing is not news; alerting on it would mail every
  // five minutes.  It was already reported when first recorded.
  const news =
    upgraded ||
    report.wafDeployed ||
    report.purgedNow.length > 0 ||
    report.workersRecorded.length > 0 ||
    report.pagesRecorded.length > 0 ||
    report.r2Recorded.length > 0 ||
    report.r2Blocked.length > 0 ||
    report.workersBlocked.length > 0 ||
    report.pagesBlocked.length > 0;
  if (!news) return;

  const lines: string[] = [];
  if (upgraded) {
    lines.push(
      'A per-billing-cycle limit is also breached: this kill now resets at the start of the billing period, not at 00:00 UTC.',
      '',
      'Breaches now:',
      breachSummary(breaches),
    );
  }
  if (report.wafDeployed) {
    lines.push('', `WAF block rule deployed (rule ${current.wafRuleId ?? '?'}).`);
  }
  lines.push(...blockLines(report), ...purgeLines(report));
  await notify(env, '[Kill Switch] Still blocked — update', lines.join('\n').trim());
}

export async function runScheduled(env: Env, cfg: AppConfig): Promise<void> {
  const state = await readState(env);
  // Fetched on killed ticks too: the auto-reset decision, escalation, purge and
  // the "block whatever appeared since" pass all need current usage.
  const evaluation = await evaluateUsage(env, cfg);

  // At most one alert per UTC day: a GraphQL or token problem would otherwise
  // leave the switch blind with nothing but log lines to show for it.
  if (evaluation.moduleErrors.length > 0 && (await shouldAlertMetricFailure(env))) {
    await notify(
      env,
      '[Kill Switch] Usage checks are failing',
      [
        'Some services could not be checked, so a breach there would go unnoticed.',
        '',
        ...evaluation.moduleErrors.map((e) => `  ${e}`),
        '',
        'This alert is sent at most once per UTC day.',
      ].join('\n'),
    );
  }

  if (state.status === 'killed') {
    await killedTick(env, cfg, state, evaluation);
    return;
  }

  if (evaluation.breaches.length === 0) {
    // If only errors (no actual breaches found), log and bail — don't false-kill.
    if (evaluation.moduleErrors.length > 0) {
      console.error(
        'Metric fetch errors (no breach detected):',
        evaluation.moduleErrors.join('; '),
      );
    }
    return;
  }

  await firstKill(env, cfg, evaluation);
}
