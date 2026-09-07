import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { blockPages, resolvePageTargets, restorePages } from '../src/actions/block-pages.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const BASE_CFG: AppConfig = { ...CONFIG };

/** Discovery + mutation, the pair runScheduled runs. They are separate exports
 *  so the kill can record each project's pre-kill deployment id before the 503
 *  bundle makes it unrecoverable. */
async function blockFromConfig(cfg: AppConfig) {
  return blockPages(env, cfg, await resolvePageTargets(env, cfg));
}

function makeProjectListResponse(...names: string[]) {
  return { success: true, errors: [], result: names.map((name) => ({ name })) };
}

function makeProjectResponse(
  deploymentId: string | null,
  productionBranch: string | null = 'main',
) {
  return {
    success: true,
    errors: [],
    result: {
      canonical_deployment: deploymentId ? { id: deploymentId } : null,
      ...(productionBranch === null ? {} : { production_branch: productionBranch }),
    },
  };
}

function makeDeployResponse() {
  return { success: true, errors: [], result: { id: 'new-deploy-id' } };
}

function makeRollbackResponse() {
  return { success: true, errors: [], result: {} };
}

describe('blockPages — empty config', () => {
  it('returns [] without calling fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: [] } };
    const result = await blockFromConfig(cfg);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('blockPages — with projects', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('saves the current deployment ID and deploys a kill bundle', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeProjectResponse('prev-deploy-id')), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(makeDeployResponse()), { status: 200 }));

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: ['my-app'] } };
    const result = await blockFromConfig(cfg);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ project: 'my-app', previousDeploymentId: 'prev-deploy-id' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('uses POST to the deployments endpoint with _worker.bundle', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeProjectResponse('d-1')), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(makeDeployResponse()), { status: 200 }));

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: ['my-app'] } };
    await blockFromConfig(cfg);

    const [deployUrl, deployInit] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect(deployUrl).toContain('/pages/projects/my-app/deployments');
    expect(deployInit.method).toBe('POST');
    // Body is FormData (not JSON), so Content-Type is NOT manually set to application/json.
    expect(deployInit.headers).not.toHaveProperty('Content-Type', 'application/json');
  });

  it("deploys to the project's production branch (a preview branch would not block the live site)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeProjectResponse('d-1', 'release')), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(makeDeployResponse()), { status: 200 }));

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: ['my-app'] } };
    await blockFromConfig(cfg);

    const [, deployInit] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    expect((deployInit.body as FormData).get('branch')).toBe('release');
  });

  it('skips project when production_branch is missing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeProjectResponse('d-1', null)), { status: 200 }),
    );

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: ['my-app'] } };
    const result = await blockFromConfig(cfg);
    expect(result).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('skips project with no canonical deployment', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeProjectResponse(null)), { status: 200 }),
    );

    const cfg: AppConfig = {
      ...BASE_CFG,
      blocking: { ...BASE_CFG.blocking, pages: ['new-project'] },
    };
    const result = await blockFromConfig(cfg);
    expect(result).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('returns only successfully blocked projects when some fail', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'POST' && url.includes('/deployments')) {
        return url.includes('fail-app')
          ? new Response(
              JSON.stringify({ success: false, errors: [{ code: 9999, message: 'fail' }] }),
              { status: 500 },
            )
          : new Response(JSON.stringify(makeDeployResponse()), { status: 200 });
      }
      const id = url.includes('fail-app') ? 'd-fail' : 'd-ok';
      return new Response(JSON.stringify(makeProjectResponse(id)), { status: 200 });
    });

    const cfg: AppConfig = {
      ...BASE_CFG,
      blocking: { ...BASE_CFG.blocking, pages: ['ok-app', 'fail-app'] },
    };
    const result = await blockFromConfig(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]?.project).toBe('ok-app');
  });
});

describe('blockPages — all mode', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('lists projects via GET /pages/projects then blocks each one', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeProjectListResponse('site-a')), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeProjectResponse('d-a')), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(makeDeployResponse()), { status: 200 }));

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: 'all' } };
    const result = await blockFromConfig(cfg);

    expect(result).toEqual([{ project: 'site-a', previousDeploymentId: 'd-a' }]);
    const [listUrl] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(listUrl).toContain('/pages/projects');
    expect(listUrl).not.toContain('/deployments');
  });

  it('returns [] without further fetches when no projects exist', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(makeProjectListResponse()), { status: 200 }),
    );

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: 'all' } };
    const result = await blockFromConfig(cfg);
    expect(result).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('restorePages', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('calls POST /rollback for each blocked project', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(makeRollbackResponse()), { status: 200 }),
    );
    await restorePages(env, [{ project: 'my-app', previousDeploymentId: 'prev-id' }]);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/pages/projects/my-app/deployments/prev-id/rollback');
    expect(init.method).toBe('POST');
  });

  it('returns the entries that failed to roll back instead of throwing', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 8000, message: 'no previous deploy' }],
          }),
          { status: 400 },
        ),
      ),
    );
    await expect(
      restorePages(env, [{ project: 'my-app', previousDeploymentId: 'bad-id' }]),
    ).resolves.toEqual([{ project: 'my-app', previousDeploymentId: 'bad-id' }]);
  });

  it('is a no-op for an empty array', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await restorePages(env, []);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('resolvePageTargets', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('captures the pre-kill deployment and production branch without deploying', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(makeProjectResponse('prev-1', 'release')), { status: 200 }),
    );

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, pages: ['my-app'] } };
    const targets = await resolvePageTargets(env, cfg);

    expect(targets).toEqual([
      { project: 'my-app', previousDeploymentId: 'prev-1', productionBranch: 'release' },
    ]);
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('drops a project whose inspection fails rather than failing the whole kill', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('broken')) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 9999, message: 'boom' }] }),
          { status: 500 },
        );
      }
      return new Response(JSON.stringify(makeProjectResponse('prev-ok')), { status: 200 });
    });

    const cfg: AppConfig = {
      ...BASE_CFG,
      blocking: { ...BASE_CFG.blocking, pages: ['broken', 'fine'] },
    };
    const targets = await resolvePageTargets(env, cfg);
    expect(targets.map((t) => t.project)).toEqual(['fine']);
  });
});
