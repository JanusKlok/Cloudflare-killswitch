import type { AppConfig, Env } from '../types.js';
import { fetchRetry } from '../util/retry.js';

const CF = 'https://api.cloudflare.com/client/v4';

// Minimal ESM Worker that returns 503 for every request.
const KILL_WORKER_SRC = `export default {
  async fetch() {
    return new Response("Service temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Retry-After": "3600" },
    });
  },
};`;

const DEFAULT_COMPAT_DATE = '2025-01-01';

interface CfApiResult<T> {
  result: T;
  success: boolean;
  errors: { code: number; message: string }[];
}

interface PagesProject {
  canonical_deployment?: { id: string } | null;
}

interface PagesProjectListItem {
  name: string;
}

async function cfJson<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
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

/** Build a _worker.bundle blob: a multipart body containing metadata + a 503 Worker module. */
async function buildKillBundle(compatibilityDate: string): Promise<Blob> {
  const inner = new FormData();
  inner.append(
    'metadata',
    JSON.stringify({ compatibility_date: compatibilityDate, main_module: 'index.js' }),
  );
  inner.append(
    'index.js',
    new Blob([KILL_WORKER_SRC], { type: 'application/javascript+module' }),
    'index.js',
  );
  return new Response(inner).blob();
}

export interface BlockedPage {
  project: string;
  previousDeploymentId: string;
}

/** Blocks each Pages project in cfg.blocking.pages by deploying a 503 maintenance Worker.
 *  Returns metadata needed to restore each project later.  Failures are logged and skipped. */
export async function blockPages(env: Env, cfg: AppConfig): Promise<BlockedPage[]> {
  const pagesCfg = cfg.blocking.pages;
  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);

  let projectNames: string[];
  if (pagesCfg === 'all') {
    const projects = await cfJson<PagesProjectListItem[]>(
      env,
      `/accounts/${accountId}/pages/projects`,
    );
    projectNames = projects.map((p) => p.name);
  } else {
    projectNames = pagesCfg;
  }

  if (projectNames.length === 0) return [];

  const compatDate = cfg.blocking.pagesCompatibilityDate ?? DEFAULT_COMPAT_DATE;
  const bundle = await buildKillBundle(compatDate);
  const blocked: BlockedPage[] = [];

  await Promise.allSettled(
    projectNames.map(async (project) => {
      const projectPath = encodeURIComponent(project);
      const proj = await cfJson<PagesProject>(
        env,
        `/accounts/${accountId}/pages/projects/${projectPath}`,
      );
      const previousDeploymentId = proj.canonical_deployment?.id;
      if (!previousDeploymentId) {
        console.warn(`block-pages: ${project} has no production deployment — skipping`);
        return;
      }

      const form = new FormData();
      form.append('manifest', '{}');
      form.append('_worker.bundle', bundle, '_worker.bundle');
      form.append('branch', 'killswitch');
      form.append('commit_message', 'Kill switch activated');

      // NOTE: do not retry this request — Pages deployment creation is non-idempotent.
      const deployRes = await fetch(
        `${CF}/accounts/${accountId}/pages/projects/${projectPath}/deployments`,
        { method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, body: form },
      );
      const deployBody = (await deployRes.json()) as CfApiResult<unknown>;
      if (!deployBody.success) {
        const msg = deployBody.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
        throw new Error(`Pages deploy failed for ${project}: ${msg}`);
      }

      blocked.push({ project, previousDeploymentId });
    }),
  );

  return blocked;
}

/** Rolls each Pages project back to its pre-kill deployment.  Failures are logged and skipped. */
export async function restorePages(env: Env, blocked: BlockedPage[]): Promise<void> {
  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  await Promise.allSettled(
    blocked.map(({ project, previousDeploymentId }) =>
      cfJson<unknown>(
        env,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(previousDeploymentId)}/rollback`,
        { method: 'POST' },
      ),
    ),
  );
}
