import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { disableWorkers, enableWorkers } from '../src/actions/block-workers.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const BASE_CFG: AppConfig = { ...CONFIG };

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
    const result = await disableWorkers(env, cfg);
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
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: ['app-a', 'app-b'] } };
    const result = await disableWorkers(env, cfg);
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
        Promise.resolve(new Response(JSON.stringify({ success: false, errors: [{ code: 9999, message: 'fail' }] }), { status: 400 })),
      );
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: ['ok-script', 'fail-script'] } };
    const result = await disableWorkers(env, cfg);
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
        Promise.resolve(new Response(JSON.stringify(makeScriptList('user-app', selfName, 'another-app')), { status: 200 })),
      )
      .mockImplementation(okResp());

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    const result = await disableWorkers(env, cfg);
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
    await disableWorkers(env, cfg);

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
    await enableWorkers(env, ['app-x', 'app-y']);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    for (const [url, init] of vi.mocked(fetch).mock.calls as [string, RequestInit][]) {
      expect(url).toContain('/subdomain');
      expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
    }
  });

  it('does not throw when a re-enable call fails', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: false, errors: [{ code: 404, message: 'not found' }] }), { status: 404 })),
    );
    await expect(enableWorkers(env, ['gone-script'])).resolves.toBeUndefined();
  });
});
