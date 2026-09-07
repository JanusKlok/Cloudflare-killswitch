import type { AppConfig, Threshold } from '../src/types.js';
import {
  MAX_BILLING_CYCLE_DAY,
  MIN_BILLING_CYCLE_DAY,
  isValidBillingCycleDay,
} from '../src/billing.js';

export type IssueLevel = 'error' | 'warning' | 'note';

export interface Issue {
  level: IssueLevel;
  title: string;
  /** Follow-up lines: the consequence and the concrete fix. */
  detail: string[];
}

/** The subset of wrangler.toml the validator cross-checks against config.ts. */
export interface WranglerInfo {
  workerName?: string;
  vars: Record<string, string>;
  kvNamespaceIds: string[];
  r2Bindings: string[];
  d1Bindings: string[];
  hasSendEmail: boolean;
  sendEmailDestination?: string;
}

/** Minimal line-based TOML reader — handles exactly the shapes used in
 *  wrangler.toml(.example): [section] / [[section]] headers and
 *  `key = "string"` pairs. Not a general TOML parser on purpose: no new
 *  dependency, and anything it can't read it simply ignores. */
export function parseWranglerToml(text: string): WranglerInfo {
  const info: WranglerInfo = {
    vars: {},
    kvNamespaceIds: [],
    r2Bindings: [],
    d1Bindings: [],
    hasSendEmail: false,
  };
  let section = '';

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^\[\[?([A-Za-z0-9_.]+)\]\]?$/);
    if (header) {
      section = header[1] ?? '';
      if (section === 'send_email') info.hasSendEmail = true;
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (key === undefined || value === undefined) continue;

    if (section === '' && key === 'name') info.workerName = value;
    else if (section === 'vars') info.vars[key] = value;
    else if (section === 'kv_namespaces' && key === 'id') info.kvNamespaceIds.push(value);
    else if (section === 'r2_buckets' && key === 'binding') info.r2Bindings.push(value);
    else if (section === 'd1_databases' && key === 'binding') info.d1Bindings.push(value);
    else if (section === 'send_email' && key === 'destination_address') info.sendEmailDestination = value;
  }

  return info;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || value.includes('REPLACE_ME');
}

export function validate(cfg: AppConfig, w: WranglerInfo): Issue[] {
  const issues: Issue[] = [];
  const add = (level: IssueLevel, title: string, ...detail: string[]) =>
    issues.push({ level, title, detail });

  const workersOff = Array.isArray(cfg.blocking.workers) && cfg.blocking.workers.length === 0;
  const pagesOff = Array.isArray(cfg.blocking.pages) && cfg.blocking.pages.length === 0;

  // --- required identifiers -------------------------------------------------
  if (isPlaceholder(w.vars['CLOUDFLARE_ACCOUNT_ID'])) {
    add('error', 'CLOUDFLARE_ACCOUNT_ID is missing or a placeholder in wrangler.toml [vars]',
      'Every metric query and blocking action needs the account ID.',
      'Fix: dashboard -> Workers & Pages -> right sidebar -> Account ID.');
  }
  if (w.kvNamespaceIds.length === 0 || w.kvNamespaceIds.some(isPlaceholder)) {
    add('error', 'The KILL_SWITCH_STATE KV namespace id is missing or a placeholder',
      'The kill switch stores its state in KV — it cannot run without it.',
      'Fix: run `pnpm exec wrangler kv namespace create KILL_SWITCH_STATE` and paste the id into [[kv_namespaces]].');
  }
  if (w.workerName && w.vars['WORKER_SELF_NAME'] !== w.workerName) {
    add(cfg.blocking.workers === 'all' ? 'error' : 'warning',
      `WORKER_SELF_NAME ("${w.vars['WORKER_SELF_NAME'] ?? ''}") does not match the worker name ("${w.workerName}")`,
      "With blocking.workers = 'all' the kill switch uses WORKER_SELF_NAME to exclude itself — a mismatch means it disables its own workers.dev subdomain and can no longer serve /restore.",
      'Fix: set WORKER_SELF_NAME in [vars] to exactly the `name` value at the top of wrangler.toml.');
  }

  // --- billing cycle --------------------------------------------------------
  if (!isValidBillingCycleDay(cfg.billingCycleDay)) {
    add('error', `billingCycleDay (${String(cfg.billingCycleDay)}) must be an integer between ${MIN_BILLING_CYCLE_DAY} and ${MAX_BILLING_CYCLE_DAY}`,
      'It anchors the auto-reset and every per-cycle metric window, so an invalid value skips auto-reset entirely and mis-measures R2 operations and the storage ceilings.',
      'Fix: set billingCycleDay in src/config.ts to your billing renewal day (dashboard -> Manage Account -> Billing), or 1 for calendar months.');
  } else if (cfg.billingCycleDay > 28) {
    add('note', `billingCycleDay is ${cfg.billingCycleDay} — months shorter than that use their last day instead`,
      'A cycle set to 31 opens on Feb 28 (or Feb 29 in a leap year). That is intended; no action needed.');
  }

  // --- scope ----------------------------------------------------------------
  if (cfg.scope === 'zone' && isPlaceholder(w.vars['CLOUDFLARE_ZONE_ID'])) {
    add('error', "scope is 'zone' but CLOUDFLARE_ZONE_ID is empty or a placeholder",
      'The deploy succeeds, but the WAF call fails when the kill switch fires — no traffic gets blocked.',
      'Fix: set CLOUDFLARE_ZONE_ID in [vars] (dashboard -> your domain -> Overview -> Zone ID).',
      "No domain on your account? Set scope: 'none' in src/config.ts and configure blocking.workers / blocking.pages instead.");
  }
  if (cfg.scope === 'account') {
    add('warning', "scope 'account' requires a Cloudflare Enterprise plan",
      'Account-level WAF custom rulesets are Enterprise-only; on Free/Pro/Business the kill fails at fire time.',
      "Fix: use scope 'zone' with a real CLOUDFLARE_ZONE_ID — or 'none' if the account has no domain.");
  }
  if (cfg.scope === 'none' && workersOff && pagesOff) {
    add('error', "scope 'none' with blocking.workers and blocking.pages both empty — the kill switch would take no action on a breach",
      'With no WAF rule and nothing to block, a breach only writes a state entry.',
      "Fix: in src/config.ts set blocking.workers and/or blocking.pages (e.g. 'all'), or pick scope 'zone' if you have a domain.");
  }

  // --- email ----------------------------------------------------------------
  if (w.hasSendEmail && isPlaceholder(w.sendEmailDestination)) {
    add('error', '[[send_email]] is active but destination_address is a placeholder',
      'wrangler deploy fails with API error 10021 ("must have a valid destination_address").',
      'Fix: set a real, verified Email Routing destination address — or comment out the whole [[send_email]] block to disable email.');
  }
  if (w.hasSendEmail && !isPlaceholder(w.sendEmailDestination)
      && (isPlaceholder(w.vars['EMAIL_FROM']) || isPlaceholder(w.vars['EMAIL_TO']))) {
    add('warning', '[[send_email]] is configured but EMAIL_FROM / EMAIL_TO are missing or placeholders',
      'Alert emails are silently skipped unless the binding AND both vars are set.',
      'Fix: set EMAIL_FROM and EMAIL_TO under [vars] (EMAIL_TO must match destination_address).');
  }
  if (!w.hasSendEmail
      && (!isPlaceholder(w.vars['EMAIL_FROM']) || !isPlaceholder(w.vars['EMAIL_TO']))) {
    add('warning', 'EMAIL_FROM / EMAIL_TO are set but the [[send_email]] block is commented out',
      'Alert emails are silently skipped without the send_email binding.',
      'Fix: uncomment [[send_email]] in wrangler.toml, or remove the EMAIL_* vars if email is not wanted.');
  }

  // --- purge thresholds and bindings ------------------------------------------
  for (const [service, metrics] of Object.entries(cfg.limits)) {
    for (const [metric, t] of Object.entries(metrics) as [string, Threshold][]) {
      if (t.purgeAt !== undefined && t.purgeAt < t.blockAt) {
        add('error', `limits.${service}.${metric}: purgeAt (${t.purgeAt}) is below blockAt (${t.blockAt})`,
          'purgeAt is the escalation above blocking and must be >= blockAt.');
      }
    }
  }

  const r2HasPurgeAt = Object.values(cfg.limits.r2).some((t) => t.purgeAt !== undefined);
  const d1HasPurgeAt = Object.values(cfg.limits.d1).some((t) => t.purgeAt !== undefined);
  if (cfg.purgeConfig.r2.length > 0 && !r2HasPurgeAt) {
    add('warning', 'purgeConfig.r2 is set but no limits.r2.* threshold has a purgeAt — the R2 purge can never run',
      'Fix: add purgeAt to an R2 threshold in src/config.ts, or remove the purgeConfig.r2 entries.');
  }
  if (cfg.purgeConfig.d1.length > 0 && !d1HasPurgeAt) {
    add('warning', 'purgeConfig.d1 is set but no limits.d1.* threshold has a purgeAt — the D1 purge can never run',
      'Fix: add purgeAt to a D1 threshold in src/config.ts, or remove the purgeConfig.d1 entries.');
  }
  if (r2HasPurgeAt && cfg.purgeConfig.r2.length === 0) {
    add('warning', 'An R2 purgeAt threshold is set but purgeConfig.r2 is empty — a purge breach blocks but deletes nothing',
      'That may be intended; if you want data deleted, add purge targets to purgeConfig.r2 in src/config.ts.');
  }
  if (d1HasPurgeAt && cfg.purgeConfig.d1.length === 0) {
    add('warning', 'A D1 purgeAt threshold is set but purgeConfig.d1 is empty — a purge breach blocks but deletes nothing',
      'That may be intended; if you want data deleted, add purge targets to purgeConfig.d1 in src/config.ts.');
  }

  for (const target of cfg.purgeConfig.r2) {
    if (!w.r2Bindings.includes(target.bindingName)) {
      add('error', `purgeConfig.r2 references binding "${target.bindingName}" but wrangler.toml has no matching [[r2_buckets]] binding`,
        'The purge would fail at fire time.',
        `Fix: add an [[r2_buckets]] block with binding = "${target.bindingName}" (see wrangler.toml.example).`);
    }
  }
  for (const target of cfg.purgeConfig.d1) {
    if (!w.d1Bindings.includes(target.bindingName)) {
      add('error', `purgeConfig.d1 references binding "${target.bindingName}" but wrangler.toml has no matching [[d1_databases]] binding`,
        'The purge would fail at fire time.',
        `Fix: add a [[d1_databases]] block with binding = "${target.bindingName}" (see wrangler.toml.example).`);
    }
  }

  // --- reminders the validator cannot check itself ---------------------------
  const perms: string[] = [];
  if (cfg.scope === 'zone') perms.push('Zone -> WAF: Edit (for your zone)');
  if (cfg.scope === 'account') perms.push('Account -> Account WAF: Edit');
  if (!workersOff) perms.push('Account -> Workers Scripts: Edit');
  if (!pagesOff) perms.push('Account -> Cloudflare Pages: Edit');
  if (perms.length > 0) {
    add('note', 'CLOUDFLARE_API_TOKEN needs these permissions for this configuration:',
      ...perms.map((p) => `  - ${p}`),
      'The validator cannot inspect the token — verify at dash.cloudflare.com/profile/api-tokens.');
  }
  if (cfg.autoResetOnBillingCycle && isValidBillingCycleDay(cfg.billingCycleDay)) {
    add('note', `Auto-reset is on — traffic is restored on the first tick on or after day ${cfg.billingCycleDay} of each UTC month`,
      'Verify that matches your Cloudflare billing renewal date, or the block lifts before the quota actually resets.');
  }
  if (cfg.enableRecoveryWebhook) {
    add('note', 'The recovery webhook is enabled — RECOVERY_SECRET must be set',
      'Set it with: pnpm exec wrangler secret put RECOVERY_SECRET',
      'Without it, POST /restore fails closed with HTTP 500.');
  }

  return issues;
}
