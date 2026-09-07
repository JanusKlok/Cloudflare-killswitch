import type { AppConfig, Env } from '../types.js';
import { cfFetch } from '../util/cf-api.js';

interface WorkerScript {
  id: string;
}

/** Toggling a subdomain is idempotent (it sets a desired state rather than
 *  creating anything), so retrying a transient failure here is safe. */
async function setSubdomain(env: Env, scriptName: string, enabled: boolean): Promise<void> {
  await cfFetch<unknown>(
    env.CLOUDFLARE_API_TOKEN,
    `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    { method: 'POST', body: JSON.stringify({ enabled }) },
  );
}

/** Resolves cfg.blocking.workers into concrete script names without changing
 *  anything.  Split from disableWorkers so the caller can record what it is
 *  about to touch before touching it. */
export async function resolveWorkerTargets(env: Env, cfg: AppConfig): Promise<string[]> {
  const workersCfg = cfg.blocking.workers;
  if (Array.isArray(workersCfg)) return [...workersCfg];

  if (!env.WORKER_SELF_NAME) {
    throw new Error(
      "blocking.workers: 'all' mode requires WORKER_SELF_NAME var in wrangler.toml — refusing to disable scripts without knowing the kill-switch's own name",
    );
  }
  const scripts = await cfFetch<WorkerScript[]>(
    env.CLOUDFLARE_API_TOKEN,
    `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts`,
  );
  return scripts.map((s) => s.id).filter((name) => name !== env.WORKER_SELF_NAME);
}

/** Disables the workers.dev subdomain for each named script.
 *  Returns the names of scripts that were successfully disabled. */
export async function disableWorkers(env: Env, scriptNames: string[]): Promise<string[]> {
  if (scriptNames.length === 0) return [];

  const results = await Promise.allSettled(
    scriptNames.map(async (name) => {
      await setSubdomain(env, name, false);
      return name;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'rejected') {
      console.error(`block-workers: ${scriptNames[i] ?? '(unknown)'} not disabled:`, result.reason);
    }
  }

  return results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map((r) => r.value);
}

/** Re-enables the workers.dev subdomain for each named script.
 *  Returns the names of scripts that FAILED to re-enable so callers can keep
 *  them recorded for a retry instead of silently losing them. */
export async function enableWorkers(env: Env, scriptNames: string[]): Promise<string[]> {
  const results = await Promise.allSettled(scriptNames.map((name) => setSubdomain(env, name, true)));
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'rejected') {
      console.error(`enable-workers: ${scriptNames[i] ?? '(unknown)'} not re-enabled:`, result.reason);
    }
  }
  return scriptNames.filter((_, i) => results[i]?.status === 'rejected');
}
