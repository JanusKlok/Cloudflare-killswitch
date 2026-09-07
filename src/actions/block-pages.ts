import type { AppConfig, Env } from '../types.js';
import { cfFetch } from '../util/cf-api.js';

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

interface PagesProject {
  canonical_deployment?: { id: string } | null;
  production_branch?: string;
}

interface PagesProjectListItem {
  name: string;
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
  const token = env.CLOUDFLARE_API_TOKEN;

  let projectNames: string[];
  if (pagesCfg === 'all') {
    const projects = await cfFetch<PagesProjectListItem[]>(
      token,
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

  const results = await Promise.allSettled(
    projectNames.map(async (project) => {
      const projectPath = encodeURIComponent(project);
      const proj = await cfFetch<PagesProject>(
        token,
        `/accounts/${accountId}/pages/projects/${projectPath}`,
      );
      const previousDeploymentId = proj.canonical_deployment?.id;
      if (!previousDeploymentId) {
        console.warn(`block-pages: ${project} has no production deployment — skipping`);
        return;
      }
      // Pages treats a deployment as production only when its branch matches the
      // project's production branch — any other branch becomes a preview deployment
      // that leaves the live site untouched.
      const productionBranch = proj.production_branch;
      if (!productionBranch) {
        console.warn(`block-pages: ${project} has no production_branch — skipping`);
        return;
      }

      const form = new FormData();
      form.append('manifest', '{}');
      form.append('_worker.bundle', bundle, '_worker.bundle');
      form.append('branch', productionBranch);
      form.append('commit_message', 'Kill switch activated');

      // retry off: creating a Pages deployment is non-idempotent.
      await cfFetch<unknown>(token, `/accounts/${accountId}/pages/projects/${projectPath}/deployments`, {
        method: 'POST',
        retry: false,
        body: form,
      });

      blocked.push({ project, previousDeploymentId });
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'rejected') {
      console.error(`block-pages: ${projectNames[i] ?? '(unknown)'} not blocked:`, result.reason);
    }
  }

  return blocked;
}

/** Rolls each Pages project back to its pre-kill deployment.
 *  Returns the entries that FAILED to roll back so callers can keep them
 *  recorded for a retry instead of silently losing them. */
export async function restorePages(env: Env, blocked: BlockedPage[]): Promise<BlockedPage[]> {
  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const results = await Promise.allSettled(
    blocked.map(({ project, previousDeploymentId }) =>
      cfFetch<unknown>(
        env.CLOUDFLARE_API_TOKEN,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(previousDeploymentId)}/rollback`,
        { method: 'POST' },
      ),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'rejected') {
      console.error(`restore-pages: ${blocked[i]?.project ?? '(unknown)'} not rolled back:`, result.reason);
    }
  }
  return blocked.filter((_, i) => results[i]?.status === 'rejected');
}
