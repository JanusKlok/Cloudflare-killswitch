export type Severity = 'block' | 'purge';

export interface Threshold {
  blockAt: number;
  /** Optional — must be >= blockAt. When set, breaching this triggers data purge. */
  purgeAt?: number;
}

export interface MetricSample {
  metric: string;
  value: number;
  window: 'day' | 'month';
}

export interface Breach {
  service: string;
  metric: string;
  observed: number;
  limit: number;
  severity: Severity;
  window: 'day' | 'month';
}

export interface ServiceModule {
  name: string;
  fetchUsage(env: Env, cfg: AppConfig): Promise<MetricSample[]>;
  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[];
}

export interface KvState {
  status: 'active' | 'killed';
  timestamp: string;
  reason?: string;
  wafRuleId?: string;
  wafRulesetId?: string;
  disabledWorkerScripts?: string[];
  blockedPagesProjects?: Array<{ project: string; previousDeploymentId: string }>;
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

export interface BlockingConfig {
  /** Workers scripts to disable on kill.
   *  'all' = auto-discover every script except the kill-switch itself.
   *  string[] = explicit list of script names. */
  workers: 'all' | string[];
  /** Pages project names to block by deploying a 503 maintenance worker.
   *  'all' = auto-discover every Pages project on the account.
   *  string[] = explicit list of project names. */
  pages: 'all' | string[];
  /** Compatibility date for the 503 maintenance worker deployed to blocked Pages projects.
   *  Defaults to '2025-01-01'. Bump if you start seeing compatibility warnings. */
  pagesCompatibilityDate?: string;
}

export interface AppConfig {
  /** 'zone' = protect a single zone (free-tier friendly).
   *  'account' = protect all zones (requires paid Cloudflare plan). */
  scope: 'zone' | 'account';
  autoResetOnFirstOfMonth: boolean;
  enableRecoveryWebhook: boolean;
  limits: {
    workers: WorkersLimits;
    pages: PagesLimits;
    kv: KvLimits;
    r2: R2Limits;
    d1: D1Limits;
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
  // Optional — only present if [[send_email]] is configured in wrangler.toml
  SEND_EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_TO?: string;
}
