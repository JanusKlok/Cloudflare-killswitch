import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { urlOf } from './helpers.js';
import { env } from 'cloudflare:workers';
import {
  disableWorkers,
  enableWorkers,
  resolveWorkerTargets,
} from '../src/actions/block-workers.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const BASE_CFG: AppConfig = { ...CONFIG };

/** Discovery + mutation, the pair runScheduled runs. They are separate exports
 *  so the kill can record its targets before changing anything. */
async function blockFromConfig(cfg: AppConfig): Promise<string[]> {
  return disableWorkers(env, await resolveWorkerTargets(env, cfg));
}

function makeScriptList(...names: string[]) {
  return { success: true, errors: [], result: names.map((id) => ({ id })) };
}

function makeOk() {
  return { success: true, errors: [], result: {} };
}

function okResp(body = makeOk()) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe('disableWorkers — empty config', () => {
  it('returns [] immediately without calling fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: [] } };
    const result = await blockFromConfig(cfg);
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('disableWorkers — explicit list', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('disables each named script and returns their names', async () => {
    vi.mocked(fetch).mockImplementation(okResp());
    const cfg: AppConfig = {
      ...BASE_CFG,
      blocking: { ...BASE_CFG.blocking, workers: ['app-a', 'app-b'] },
    };
    const result = await blockFromConfig(cfg);
    expect(result.sort()).toEqual(['app-a', 'app-b']);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/workers/scripts/');
    expect(url).toContain('/subdomain');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });

  it('returns only successfully disabled scripts when some fail', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(okResp())
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: false, errors: [{ code: 9999, message: 'fail' }] }),
            { status: 400 },
          ),
        ),
      );
    const cfg: AppConfig = {
      ...BASE_CFG,
      blocking: { ...BASE_CFG.blocking, workers: ['ok-script', 'fail-script'] },
    };
    const result = await blockFromConfig(cfg);
    expect(result).toEqual(['ok-script']);
  });
});

describe('disableWorkers — all mode', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('excludes the kill-switch script itself', async () => {
    const selfName = env.WORKER_SELF_NAME;
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify(makeScriptList('user-app', selfName, 'another-app')), {
            status: 200,
          }),
        ),
      )
      .mockImplementation(okResp());

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    const result = await blockFromConfig(cfg);
    expect(result).not.toContain(selfName);
    expect(result.sort()).toEqual(['another-app', 'user-app']);
  });

  it('lists scripts via GET /workers/scripts before disabling', async () => {
    vi.mocked(fetch)
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(JSON.stringify(makeScriptList('only-app')), { status: 200 })),
      )
      .mockImplementation(okResp());

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    await blockFromConfig(cfg);

    const [listUrl] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(listUrl).toContain('/workers/scripts');
    expect(listUrl).not.toContain('/subdomain');
  });
});

describe('enableWorkers', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('calls POST /subdomain with enabled:true for each script', async () => {
    vi.mocked(fetch).mockImplementation(okResp());
    const failed = await enableWorkers(env, ['app-x', 'app-y']);
    expect(failed).toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    for (const [url, init] of vi.mocked(fetch).mock.calls as [string, RequestInit][]) {
      expect(url).toContain('/subdomain');
      expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    }
  });

  it('returns the names of scripts that failed to re-enable instead of throwing', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 404, message: 'not found' }] }),
          { status: 404 },
        ),
      ),
    );
    await expect(enableWorkers(env, ['gone-script'])).resolves.toEqual(['gone-script']);
  });
});

describe('resolveWorkerTargets', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns an explicit list without calling the API', async () => {
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: ['a', 'b'] } };
    await expect(resolveWorkerTargets(env, cfg)).resolves.toEqual(['a', 'b']);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not mutate anything — discovery is read-only', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(makeScriptList('user-app')), { status: 200 })),
    );
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    await resolveWorkerTargets(env, cfg);

    const subdomainCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => urlOf(input).includes('/subdomain'));
    expect(subdomainCalls).toHaveLength(0);
  });
});
