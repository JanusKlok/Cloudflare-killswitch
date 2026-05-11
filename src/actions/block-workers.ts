import type { AppConfig, Env } from '../types.js';
import { fetchRetry } from '../util/retry.js';

const CF = 'https://api.cloudflare.com/client/v4';

interface WorkerScript {
  id: string;
}

interface CfApiResult<T> {
  result: T;
  success: boolean;
  errors: { code: number; message: string }[];
}

async function cfFetch<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchRetry(`${CF}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json()) as CfApiResult<T>;
  if (!body.success) {
    const msg = body.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cloudflare API error (${res.status}): ${msg}`);
  }
  return body.result;
}

async function setSubdomain(env: Env, scriptName: string, enabled: boolean): Promise<void> {
  await cfFetch<unknown>(
    env,
    `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    { method: 'POST', body: JSON.stringify({ enabled }) },
  );
}

/** Disables the workers.dev subdomain for each script in cfg.blocking.workers.
 *  Returns the names of scripts that were successfully disabled. */
export async function disableWorkers(env: Env, cfg: AppConfig): Promise<string[]> {
  const workersCfg = cfg.blocking.workers;
  if (Array.isArray(workersCfg) && workersCfg.length === 0) return [];

  let scriptNames: string[];
  if (workersCfg === 'all') {
    if (!env.WORKER_SELF_NAME) {
      throw new Error(
        "blocking.workers: 'all' mode requires WORKER_SELF_NAME var in wrangler.toml — refusing to disable scripts without knowing the kill-switch's own name",
      );
    }
    const scripts = await cfFetch<WorkerScript[]>(
      env,
      `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts`,
    );
    scriptNames = scripts.map((s) => s.id).filter((name) => name !== env.WORKER_SELF_NAME);
  } else {
    scriptNames = workersCfg;
  }

  const results = await Promise.allSettled(
    scriptNames.map(async (name) => {
      await setSubdomain(env, name, false);
      return name;
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map((r) => r.value);
}

/** Re-enables the workers.dev subdomain for each named script. */
export async function enableWorkers(env: Env, scriptNames: string[]): Promise<void> {
  await Promise.allSettled(scriptNames.map((name) => setSubdomain(env, name, true)));
}
