export type Severity = 'block' | 'purge';

export interface Threshold {
  blockAt: number;
  /** Optional — must be >= blockAt. When set, breaching this triggers data purge. */
  purgeAt?: number;
}

/** 'day' = a UTC-day quota (resets 00:00 UTC).
 *  'cycle' = a per-billing-period quota or ceiling (see src/billing.ts). */
export type MetricWindow = 'day' | 'cycle';

export interface MetricSample {
  metric: string;
  value: number;
  window: MetricWindow;
}

export interface Breach {
  service: string;
  metric: string;
  observed: number;
  limit: number;
  severity: Severity;
  window: MetricWindow;
}

/** One module's share of the merged GraphQL request (see metrics/collect.ts). */
export interface UsageQuery {
  /** Response keys this selection adds under `accounts[0]`.  A GraphQL error
   *  whose `path` runs through one of these is attributed to this module. */
  keys: string[];
  /** Fields selected under `accounts(filter: { accountTag })`. */
  selection: string;
  /** Variables the selection uses.  Names must be unique across all modules
   *  (prefix them with the module name); `$accountTag` is supplied by the collector. */
  variables: Record<string, { type: string; value: string }>;
}

/** The `accounts[0]` object of a GraphQL response, before a module types it. */
export type AccountData = Record<string, unknown>;

export interface ServiceModule {
  name: string;
  /** What this module needs from the GraphQL Analytics API. */
  query(cfg: AppConfig): UsageQuery;
  /** Turns this module's slice of the response into samples; throws on data it cannot trust. */
  parse(account: AccountData): MetricSample[];
  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[];
}

/** A Worker's workers.dev exposure as it was before the kill. */
export interface WorkerSubdomainRecord {
  script: string;
  enabled: boolean;
  previewsEnabled: boolean;
}

/** A bucket whose r2.dev URL was on before the kill.  `jurisdiction` is set
 *  only for non-default buckets, which the API addresses via a header. */
export interface R2BucketRecord {
  bucket: string;
  jurisdiction?: string;
  /** The r2.dev state could not be read before blocking.  The bucket is still
   *  blocked, but restore never re-enables it: it may have been private, and
   *  re-exposing a private bucket is a data-exposure risk. */
  priorStateUnknown?: true;
}

export interface KvState {
  status: 'active' | 'killed';
  /** When this state record was last written. */
  timestamp: string;
  /** When the kill originally fired.  Preserved verbatim across partial-restore
   *  rewrites so the billing-period comparison in shouldAutoReset keeps its
   *  anchor.  Absent on states written before this field existed. */
  killedAt?: string;
  reason?: string;
  wafRuleId?: string;
  wafRulesetId?: string;
  /** Workers whose workers.dev subdomain the kill switched off, with the state
   *  to restore.  Bare strings are the v2.0.0 shape (restored as enabled:true,
   *  previews untouched) and must keep restoring. */
  disabledWorkerScripts?: Array<string | WorkerSubdomainRecord>;
  /** Pages projects the kill switched to the empty deployment.  `productionBranch`
   *  is what a later retry deploys to; absent on v2.0.0 states, which never
   *  retried. */
  blockedPagesProjects?: Array<{
    project: string;
    previousDeploymentId: string;
    productionBranch?: string;
  }>;
  /** Which quota window must roll over before auto-reset is due: 'day' resets at
   *  00:00 UTC, 'cycle' at the billing period start.  'cycle' if ANY breach that
   *  caused the kill was per-cycle.  Absent (v2.0.0 states) means 'cycle'. */
  resetWindow?: 'day' | 'cycle';
  /** Services whose purge already ran during this kill.  Its mere presence marks
   *  a v3 state: v2.0.0 states lack it and may already have purged, so killed
   *  ticks never purge for them. */
  purgedServices?: string[];
  /** Recorded Workers whose disable call has not succeeded yet (retried each tick). */
  pendingWorkerBlocks?: string[];
  /** Recorded Pages projects whose kill deployment has not succeeded yet (retried each tick). */
  pendingPagesBlocks?: string[];
  /** R2 buckets whose r2.dev URL the kill turned off (only ones that were on). */
  blockedR2Buckets?: R2BucketRecord[];
  /** Recorded R2 buckets whose disable call has not succeeded yet (retried each tick). */
  pendingR2Blocks?: string[];
  /** Set by a partly failed restore: the recorded items still need undoing, and
   *  killed ticks retry the restore instead of blocking anything new. */
  restorePending?: boolean;
}

export interface R2PurgeTarget {
  /** Must match a [[r2_buckets]] binding name in wrangler.toml exactly. */
  bindingName: string;
  /** Limit purge to these key prefixes. Empty array means the entire bucket. */
  prefixes: string[];
  /** Which objects to delete first. */
  deleteOrder: 'newest' | 'oldest';
}

export interface D1TableAction {
  name: string;
  /** DELETE_ALL runs DELETE FROM <table>; DROP runs DROP TABLE <table>. */
  action: 'DELETE_ALL' | 'DROP';
}

export interface D1PurgeTarget {
  /** Must match a [[d1_databases]] binding name in wrangler.toml exactly. */
  bindingName: string;
  /** Tables are processed in the order listed. */
  tables: D1TableAction[];
}

export interface WorkersLimits {
  requests: Threshold;
}

export interface PagesLimits {
  /** Pages Functions invocations/day. */
  requests: Threshold;
}

export interface KvLimits {
  reads: Threshold;
  writes: Threshold;
  /** Cloudflare meters deletes and lists separately from writes (1,000/day each on Free). */
  deletes: Threshold;
  lists: Threshold;
  storageBytes: Threshold;
}

export interface R2Limits {
  storageBytes: Threshold;
  classAOps: Threshold;
  classBOps: Threshold;
}

export interface D1Limits {
  rowReads: Threshold;
  rowWrites: Threshold;
  storageBytes: Threshold;
}

export interface CombinedLimits {
  /** Workers + Pages Functions requests/day, summed.  Pages Functions bill
   *  against the same Workers quota, so the per-service limits alone can each
   *  stay under while the shared quota is exceeded. */
  requests: Threshold;
}

export interface BlockingConfig {
  /** Workers scripts to disable on kill.
   *  'all' = auto-discover every script except the kill-switch itself.
   *  string[] = explicit list of script names. */
  workers: 'all' | string[];
  /** Pages projects to block by replacing the production deployment with an
   *  empty one (404 everywhere, free static requests).
   *  'all' = auto-discover every Pages project on the account.
   *  string[] = explicit list of project names. */
  pages: 'all' | string[];
  /** @deprecated Ignored — the Pages block no longer deploys a Worker.  Kept so
   *  older configs that set it still type-check. */
  pagesCompatibilityDate?: string;
  /** R2 buckets whose public r2.dev URL is turned off on kill.
   *  'all' = every bucket on the account; string[] = explicit bucket names.
   *  Absent or [] = R2 is not touched.  Custom domains and S3-API access are not blocked. */
  r2?: 'all' | string[];
}

export interface AppConfig {
  /** 'zone' = protect a single zone (free-tier friendly).
   *  'account' = protect all zones (requires an Enterprise plan).
   *  'none' = deploy no WAF rule — rely solely on blocking.workers/pages.
   *           For accounts with no zone (workers.dev / pages.dev only). */
  scope: 'zone' | 'account' | 'none';
  /** Day of the UTC month your Cloudflare billing period starts — the day of
   *  the month the account was created, not necessarily the 1st.  Must be an
   *  integer 1-31; values past the end of a short month fall back to that
   *  month's last day.  Anchors both the auto-reset and every per-cycle metric
   *  window, so it is required even with autoResetOnBillingCycle off.
   *  Set to 1 for plain calendar-month behaviour. */
  billingCycleDay: number;
  /** Automatically restore once the quota that caused the kill has reset and
   *  nothing is over a limit: after 00:00 UTC for a kill caused only by daily
   *  quotas, else at the next billing period (requires a valid billingCycleDay). */
  autoResetOnBillingCycle: boolean;
  enableRecoveryWebhook: boolean;
  limits: {
    workers: WorkersLimits;
    pages: PagesLimits;
    kv: KvLimits;
    r2: R2Limits;
    d1: D1Limits;
    /** Optional — see CombinedLimits. */
    combined?: CombinedLimits;
  };
  purgeConfig: {
    r2: R2PurgeTarget[];
    d1: D1PurgeTarget[];
  };
  blocking: BlockingConfig;
}

export interface Env {
  // KV namespace for state
  KILL_SWITCH_STATE: KVNamespace;
  // Secrets (set via `wrangler secret put`)
  CLOUDFLARE_API_TOKEN: string;
  RECOVERY_SECRET: string;
  // Vars (set in wrangler.toml [vars])
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ZONE_ID: string;
  WORKER_SELF_NAME: string;
  /** Optional — the hostname POST /restore is served on (e.g.
   *  "killswitch.example.workers.dev").  When set, the WAF block rule exempts
   *  /restore only on this host instead of zone-wide. */
  RECOVERY_HOSTNAME?: string;
  /** Optional — Workers Rate Limiting binding for POST /restore, declared via
   *  [[ratelimits]] in wrangler.toml.  When absent, an in-memory limiter is used. */
  RESTORE_RATE_LIMITER?: RateLimit;
  // Optional — only present if [[send_email]] is configured in wrangler.toml
  SEND_EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
  /** Optional secret (`wrangler secret put ALERT_WEBHOOK_URL`) — https URL of a
   *  Discord, Slack or ntfy-style webhook that receives every alert. */
  ALERT_WEBHOOK_URL?: string;
}
