import type { AppConfig, Env, WorkerSubdomainRecord } from '../types.js';
import { CfApiError, cfFetch } from '../util/cf-api.js';

interface WorkerScript {
  id: string;
}

interface SubdomainState {
  enabled?: unknown;
  previews_enabled?: unknown;
}

/** A recorded entry as found in KV: v2.0.0 wrote bare script names. */
export type RecordedWorker = string | WorkerSubdomainRecord;

export function workerScriptName(entry: RecordedWorker): string {
  return typeof entry === 'string' ? entry : entry.script;
}

/** Merges freshly resolved records into already-recorded ones, existing
 *  entries winning.  Once a kill has run, a disabled script's GET reports
 *  enabled:false, so re-resolving would otherwise overwrite the true
 *  pre-kill values and restore would leave the script dark. */
export function mergeWorkerRecords(
  existing: readonly RecordedWorker[],
  fresh: readonly WorkerSubdomainRecord[],
): RecordedWorker[] {
  const known = new Set(existing.map(workerScriptName));
  return [...existing, ...fresh.filter((r) => !known.has(r.script))];
}

function subdomainPath(env: Env, scriptName: string): string {
  return `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`;
}

/** Toggling a subdomain is idempotent (it sets a desired state rather than
 *  creating anything), so retrying a transient failure here is safe.
 *  The docs do not say what an omitted field does on POST, so callers send
 *  `previews_enabled` explicitly unless they deliberately want it left alone. */
async function setSubdomain(
  env: Env,
  scriptName: string,
  body: { enabled: boolean; previews_enabled?: boolean },
): Promise<void> {
  await cfFetch<unknown>(env.CLOUDFLARE_API_TOKEN, subdomainPath(env, scriptName), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Reads a script's current workers.dev exposure.  Returns null when the
 *  script does not exist (nothing to block), and throws on any other failure. */
async function readSubdomain(env: Env, scriptName: string): Promise<WorkerSubdomainRecord | null> {
  let state: SubdomainState;
  try {
    state = await cfFetch<SubdomainState>(env.CLOUDFLARE_API_TOKEN, subdomainPath(env, scriptName));
  } catch (err) {
    if (err instanceof CfApiError && err.isNotFound) return null;
    throw err;
  }
  if (typeof state?.enabled !== 'boolean' || typeof state.previews_enabled !== 'boolean') {
    throw new Error(`unexpected subdomain response for ${scriptName}`);
  }
  return { script: scriptName, enabled: state.enabled, previewsEnabled: state.previews_enabled };
}

/** Resolves cfg.blocking.workers into the scripts that are actually exposed,
 *  without changing anything.  Split from disableWorkers so the caller can
 *  record what it is about to touch before touching it.
 *
 *  Only scripts with workers.dev or preview URLs currently on are recorded,
 *  with their original values: restoring blindly with enabled:true would make
 *  a cron-only or service-binding-only Worker publicly reachable.
 *
 *  One GET per script runs concurrently (Workers Free allows 50 subrequests
 *  per invocation).  Scripts in `known` (already recorded by this kill) are
 *  skipped before their GET: it would report enabled:false and cost a
 *  subrequest. */
export async function resolveWorkerTargets(
  env: Env,
  cfg: AppConfig,
  known: ReadonlySet<string> = new Set(),
): Promise<WorkerSubdomainRecord[]> {
  const workersCfg = cfg.blocking.workers;
  let names: string[];
  if (Array.isArray(workersCfg)) {
    names = [...workersCfg];
  } else {
    if (!env.WORKER_SELF_NAME) {
      throw new Error(
        "blocking.workers: 'all' mode requires WORKER_SELF_NAME var in wrangler.toml — refusing to disable scripts without knowing the kill-switch's own name",
      );
    }
    const scripts = await cfFetch<WorkerScript[]>(
      env.CLOUDFLARE_API_TOKEN,
      `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts`,
    );
    names = scripts.map((s) => s.id).filter((name) => name !== env.WORKER_SELF_NAME);
  }

  names = names.filter((name) => !known.has(name));
  const results = await Promise.allSettled(names.map((name) => readSubdomain(env, name)));
  const targets: WorkerSubdomainRecord[] = [];
  results.forEach((result, i) => {
    const name = names[i] ?? '(unknown)';
    if (result.status === 'fulfilled') {
      if (result.value && (result.value.enabled || result.value.previewsEnabled)) {
        targets.push(result.value);
      }
      return;
    }
    // Unknown exposure: skipping would leave a possibly-public script serving
    // through the kill, so block it anyway.  Assume only the main subdomain was
    // on (the v2.0.0 behaviour) so restore re-enables no more than it used to.
    console.error(`block-workers: could not read subdomain state of ${name}:`, result.reason);
    targets.push({ script: name, enabled: true, previewsEnabled: false });
  });
  return targets;
}

/** Turns off the workers.dev subdomain and preview URLs of each recorded script.
 *  Returns the records that were successfully disabled. */
export async function disableWorkers(
  env: Env,
  targets: WorkerSubdomainRecord[],
): Promise<WorkerSubdomainRecord[]> {
  if (targets.length === 0) return [];

  const results = await Promise.allSettled(
    targets.map((t) => setSubdomain(env, t.script, { enabled: false, previews_enabled: false })),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(
        `block-workers: ${targets[i]?.script ?? '(unknown)'} not disabled:`,
        result.reason,
      );
    }
  });

  return targets.filter((_, i) => results[i]?.status === 'fulfilled');
}

/** Restores each script's recorded workers.dev exposure.  Legacy string entries
 *  (v2.0.0) get enabled:true with previews left alone, exactly as v2.0.0 did.
 *  Returns the entries that FAILED, unchanged, so callers can keep them
 *  recorded for a retry instead of silently losing them. */
export async function enableWorkers(
  env: Env,
  entries: RecordedWorker[],
): Promise<RecordedWorker[]> {
  const results = await Promise.allSettled(
    entries.map((entry) =>
      typeof entry === 'string'
        ? setSubdomain(env, entry, { enabled: true })
        : setSubdomain(env, entry.script, {
            enabled: entry.enabled,
            previews_enabled: entry.previewsEnabled,
          }),
    ),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const entry = entries[i];
      console.error(
        `enable-workers: ${entry === undefined ? '(unknown)' : workerScriptName(entry)} not re-enabled:`,
        result.reason,
      );
    }
  });
  return entries.filter((_, i) => results[i]?.status === 'rejected');
}
