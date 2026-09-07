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
export interface PageTarget extends BlockedPage {
  productionBranch: string;
}

/** Resolves cfg.blocking.pages into concrete projects and reads the deployment
 *  each must later be rolled back to, without changing anything.  Split from
 *  blockPages so the caller can record these first: previousDeploymentId is
 *  unrecoverable once the 503 bundle becomes the live deployment. */
export async function resolvePageTargets(env: Env, cfg: AppConfig): Promise<PageTarget[]> {
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
    projectNames = [...pagesCfg];
  }
  if (projectNames.length === 0) return [];

  const discovered = await Promise.allSettled(
    projectNames.map(async (project): Promise<PageTarget | undefined> => {
      const proj = await cfFetch<PagesProject>(
        token,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`,
      );
      const previousDeploymentId = proj.canonical_deployment?.id;
      if (!previousDeploymentId) {
        console.warn(`block-pages: ${project} has no production deployment — skipping`);
        return undefined;
      }
      // Pages treats a deployment as production only when its branch matches the
      // project's production branch — any other branch becomes a preview deployment
      // that leaves the live site untouched.
      const productionBranch = proj.production_branch;
      if (!productionBranch) {
        console.warn(`block-pages: ${project} has no production_branch — skipping`);
        return undefined;
      }
      return { project, previousDeploymentId, productionBranch };
    }),
  );

  const targets: PageTarget[] = [];
  for (let i = 0; i < discovered.length; i++) {
    const result = discovered[i];
    if (result?.status === 'rejected') {
      console.error(
        `block-pages: could not inspect ${projectNames[i] ?? '(unknown)'}:`,
        result.reason,
      );
    } else if (result?.status === 'fulfilled' && result.value) {
      targets.push(result.value);
    }
  }
  return targets;
}

/** Deploys the 503 maintenance Worker to each resolved target.
 *  Returns the targets that were successfully blocked. */
export async function blockPages(
  env: Env,
  cfg: AppConfig,
  targets: PageTarget[],
): Promise<BlockedPage[]> {
  if (targets.length === 0) return [];

  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const token = env.CLOUDFLARE_API_TOKEN;
  const compatDate = cfg.blocking.pagesCompatibilityDate ?? DEFAULT_COMPAT_DATE;
  const bundle = await buildKillBundle(compatDate);
  const blocked: BlockedPage[] = [];

  const results = await Promise.allSettled(
    targets.map(async ({ project, previousDeploymentId, productionBranch }) => {
      const projectPath = encodeURIComponent(project);

      const form = new FormData();
      form.append('manifest', '{}');
      form.append('_worker.bundle', bundle, '_worker.bundle');
      form.append('branch', productionBranch);
      form.append('commit_message', 'Kill switch activated');

      // retry off: creating a Pages deployment is non-idempotent.
      await cfFetch<unknown>(
        token,
        `/accounts/${accountId}/pages/projects/${projectPath}/deployments`,
        {
          method: 'POST',
          retry: false,
          body: form,
        },
      );

      blocked.push({ project, previousDeploymentId });
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'rejected') {
      console.error(
        `block-pages: ${targets[i]?.project ?? '(unknown)'} not blocked:`,
        result.reason,
      );
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
      console.error(
        `restore-pages: ${blocked[i]?.project ?? '(unknown)'} not rolled back:`,
        result.reason,
      );
    }
  }
  return blocked.filter((_, i) => results[i]?.status === 'rejected');
}
