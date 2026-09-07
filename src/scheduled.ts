import type { AppConfig, Breach, Env } from './types.js';
import { readState, shouldAutoReset, writeKilled } from './state.js';
import { restoreFromState } from './restore.js';
import { MODULES } from './metrics/index.js';
import { deployBlockRule } from './actions/waf.js';
import { disableWorkers } from './actions/block-workers.js';
import { blockPages, type BlockedPage } from './actions/block-pages.js';
import { sendAlert } from './actions/email.js';
import { purgeR2 } from './actions/purge-r2.js';
import { purgeD1 } from './actions/purge-d1.js';
import type { PurgeResult } from './actions/purge-r2.js';
import type { D1PurgeResult } from './actions/purge-d1.js';

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
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

export async function runScheduled(env: Env, cfg: AppConfig): Promise<void> {
  // Read state first — exit fast if already killed (no auto-reset due).
  const state = await readState(env);

  if (state.status === 'killed') {
    if (shouldAutoReset(state, cfg)) {
      // Auto-reset on the 1st of the month.
      const { fullyRestored, errors } = await restoreFromState(env, cfg, state);
      if (!fullyRestored) {
        // Remnants stay recorded in the killed state — retry via /restore.
        console.error('auto-reset: partial restore failure:', errors.join('; '));
        return;
      }
      // Continue monitoring after reset.
    } else {
      return; // Already killed — no-op.
    }
  }

  // Fetch usage from all modules in parallel.  Settle-style isolation: a
  // single failing module never aborts the whole tick.
  const moduleResults = await Promise.allSettled(
    MODULES.map(async (mod) => {
      const samples = await mod.fetchUsage(env, cfg);
      return { name: mod.name, breaches: mod.evaluate(samples, cfg) };
    }),
  );

  const allBreaches: Breach[] = [];
  const moduleErrors: string[] = [];
  for (let i = 0; i < moduleResults.length; i++) {
    const result = moduleResults[i];
    const mod = MODULES[i];
    if (!result || !mod) continue;
    if (result.status === 'fulfilled') {
      allBreaches.push(...result.value.breaches);
    } else {
      moduleErrors.push(`${mod.name}: ${String(result.reason)}`);
    }
  }

  if (allBreaches.length === 0 && moduleErrors.length === 0) return;

  // If only errors (no actual breaches found), log and bail — don't false-kill.
  if (allBreaches.length === 0) {
    console.error('Metric fetch errors (no breach detected):', moduleErrors.join('; '));
    return;
  }

  const purgeBreaches = allBreaches.filter((b) => b.severity === 'purge');
  const blockBreaches = allBreaches.filter((b) => b.severity === 'block');
  const reason =
    purgeBreaches.length > 0
      ? `${purgeBreaches.length} purge breach(es), ${blockBreaches.length} block breach(es)`
      : `${blockBreaches.length} block breach(es)`;

  // One kill time, reused by both writes below: the second write must not
  // restamp it or the auto-reset anchor lands inside the current billing period.
  const killedAt = new Date().toISOString();

  // Deploy WAF block rule first (bleeding stops first).  scope 'none' means
  // there is no zone to protect — blocking.workers/pages is the whole kill.
  let wafRuleId: string | undefined;
  let wafRulesetId: string | undefined;
  const wafErrors: string[] = [];
  if (cfg.scope !== 'none') {
    try {
      ({ ruleId: wafRuleId, rulesetId: wafRulesetId } = await deployBlockRule(
        env,
        cfg,
        env.RECOVERY_HOSTNAME,
      ));
    } catch (err) {
      // A WAF failure must not abort the kill: blocking.workers/pages are
      // independent mitigations and previously never ran when this threw.
      console.error('waf deploy error:', err);
      wafErrors.push(`waf: ${String(err)}`);
    }
  }

  // Record the kill immediately: if the Worker dies mid-kill, an unrecorded
  // WAF rule would be orphaned (never removable via /restore) and the next
  // tick would re-fire the whole kill — stacking rules and re-running purges.
  // The final writeKilled below enriches this with the full action results.
  await writeKilled(env, { reason, killedAt, wafRuleId, wafRulesetId });

  // Disable workers.dev subdomains and block Pages projects in parallel.
  const [disabledWorkerScripts, blockedPagesProjects] = await Promise.all([
    disableWorkers(env, cfg).catch((err: unknown) => { console.error('block-workers error:', err); return [] as string[]; }),
    blockPages(env, cfg).catch((err: unknown) => { console.error('block-pages error:', err); return [] as BlockedPage[]; }),
  ]);

  // Run purge actions, scoped to the breaching service: purging deletes data
  // permanently, so an unrelated breach (e.g. a workers request spike) must
  // never wipe R2 buckets or D1 tables.
  const purgedServices = new Set(purgeBreaches.map((b) => b.service));
  const r2Results: PurgeResult[] = [];
  const d1Results: D1PurgeResult[] = [];

  if (purgedServices.has('r2')) {
    for (const target of cfg.purgeConfig.r2) {
      try {
        r2Results.push(await purgeR2(env, target));
      } catch (err) {
        r2Results.push({ bindingName: target.bindingName, deleted: 0, errors: [String(err)] });
      }
    }
  }
  if (purgedServices.has('d1')) {
    for (const target of cfg.purgeConfig.d1) {
      try {
        d1Results.push(await purgeD1(env, target));
      } catch (err) {
        d1Results.push({ bindingName: target.bindingName, tableResults: [{ table: '(all)', action: 'purge', success: false, error: String(err) }] });
      }
    }
  }

  const emailLines: string[] = [
    wafRuleId ? 'Kill Switch triggered. WAF block rule deployed.' : 'Kill Switch triggered.',
    '',
    'Breaches detected:',
    breachSummary(allBreaches),
  ];

  if (wafRuleId) {
    emailLines.push(
      '',
      `WAF rule ID : ${wafRuleId}`,
      `WAF ruleset : ${wafRulesetId}`,
      `Scope       : ${cfg.scope}`,
    );
  }

  if (disabledWorkerScripts.length > 0) {
    emailLines.push('', `Workers disabled (${disabledWorkerScripts.length}): ${disabledWorkerScripts.join(', ')}`);
  }
  if (blockedPagesProjects.length > 0) {
    emailLines.push('', `Pages blocked (${blockedPagesProjects.length}): ${blockedPagesProjects.map((b) => b.project).join(', ')}`);
  }

  if (r2Results.length > 0) {
    emailLines.push('', 'R2 purge results:');
    for (const r of r2Results) {
      emailLines.push(`  ${r.bindingName}: deleted ${r.deleted} object(s)`);
      if (r.errors.length) emailLines.push(`    errors: ${r.errors.join('; ')}`);
    }
  }

  if (d1Results.length > 0) {
    emailLines.push('', 'D1 purge results:');
    for (const r of d1Results) {
      for (const t of r.tableResults) {
        const status = t.success ? 'OK' : `FAILED: ${t.error}`;
        emailLines.push(`  ${r.bindingName}.${t.table} [${t.action}]: ${status}`);
      }
    }
  }

  if (wafErrors.length > 0) {
    emailLines.push('', 'WAF rule NOT deployed — traffic on the zone is still being served:', ...wafErrors.map((e) => `  ${e}`));
  }

  if (moduleErrors.length > 0) {
    emailLines.push('', 'Metric fetch errors (some services not checked):', ...moduleErrors.map((e) => `  ${e}`));
  }

  if (cfg.enableRecoveryWebhook) {
    emailLines.push('', 'To restore: POST /restore with Authorization: Bearer <RECOVERY_SECRET>');
  }

  // A transient email failure must never prevent the kill from being recorded
  // below — an unrecorded kill would re-fire every tick (stacking WAF rules,
  // orphaning the first rule's ID, and re-running purges).
  try {
    await sendAlert(env, '[Kill Switch] Traffic blocked — limits breached', emailLines.join('\n'));
  } catch (err) {
    console.error('alert email failed:', err);
  }

  await writeKilled(env, {
    reason,
    killedAt,
    wafRuleId,
    wafRulesetId,
    disabledWorkerScripts,
    blockedPagesProjects,
  });
}
