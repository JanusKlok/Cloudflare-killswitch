import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { urlOf } from './helpers.js';
import { env } from 'cloudflare:workers';
import {
  disableWorkers,
  enableWorkers,
  mergeWorkerRecords,
  resolveWorkerTargets,
} from '../src/actions/block-workers.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const BASE_CFG: AppConfig = { ...CONFIG };

/** Discovery + mutation, the pair runScheduled runs. They are separate exports
 *  so the kill can record its targets before changing anything. */
async function blockFromConfig(cfg: AppConfig): Promise<string[]> {
  const disabled = await disableWorkers(env, await resolveWorkerTargets(env, cfg));
  return disabled.map((d) => d.script);
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

interface Exposure {
  enabled: boolean;
  previews_enabled: boolean;
}

/** Routes the script list, per-script subdomain GETs and POSTs.  Scripts not in
 *  `exposure` are reported as fully public; `getFails` simulates a failed GET. */
function routedFetch(opts: {
  scripts?: string[];
  exposure?: Record<string, Exposure>;
  getFails?: string[];
  getStatus?: Record<string, number>;
}) {
  const publicState: Exposure = { enabled: true, previews_enabled: true };
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const sub = /\/scripts\/([^/]+)\/subdomain/.exec(url);
    if (!sub) return json(makeScriptList(...(opts.scripts ?? [])));
    const name = decodeURIComponent(sub[1] ?? '');
    if (init?.method === 'POST') return json(makeOk());
    const status = opts.getStatus?.[name];
    if (status) return json({ success: false, errors: [{ code: status, message: 'x' }] }, status);
    if (opts.getFails?.includes(name)) {
      return json({ success: false, errors: [{ code: 1, message: 'boom' }] }, 400);
    }
    return json({ success: true, errors: [], result: opts.exposure?.[name] ?? publicState });
  });
}

function posts() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([input, init]) => ({
      url: urlOf(input),
      body: JSON.parse((init as RequestInit).body as string) as Record<string, boolean>,
    }));
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

  it('disables each named script (subdomain and previews) and returns their names', async () => {
    vi.stubGlobal('fetch', routedFetch({}));
    const cfg: AppConfig = {
      ...BASE_CFG,
      blocking: { ...BASE_CFG.blocking, workers: ['app-a', 'app-b'] },
    };
    const result = await blockFromConfig(cfg);
    expect(result.sort()).toEqual(['app-a', 'app-b']);
    // One GET and one POST per script.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);

    expect(posts()).toHaveLength(2);
    for (const p of posts()) {
      expect(p.url).toContain('/workers/scripts/');
      expect(p.url).toContain('/subdomain');
      expect(p.body).toEqual({ enabled: false, previews_enabled: false });
    }
  });

  it('returns only successfully disabled scripts when some fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return urlOf(input).includes('fail-script')
            ? json({ success: false, errors: [{ code: 9999, message: 'fail' }] }, 400)
            : json(makeOk());
        }
        return json({
          success: true,
          errors: [],
          result: { enabled: true, previews_enabled: false },
        });
      }),
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
    vi.stubGlobal('fetch', routedFetch({ scripts: ['user-app', selfName, 'another-app'] }));

    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    const result = await blockFromConfig(cfg);
    expect(result).not.toContain(selfName);
    expect(result.sort()).toEqual(['another-app', 'user-app']);
  });

  it('lists scripts via GET /workers/scripts before disabling', async () => {
    vi.stubGlobal('fetch', routedFetch({ scripts: ['only-app'] }));

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

  it('restores each recorded value, including previews', async () => {
    vi.mocked(fetch).mockImplementation(okResp());
    const failed = await enableWorkers(env, [
      { script: 'app-x', enabled: true, previewsEnabled: false },
      { script: 'app-y', enabled: false, previewsEnabled: true },
    ]);
    expect(failed).toEqual([]);
    const sent = posts();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toEqual({ enabled: true, previews_enabled: false });
    expect(sent[1]?.body).toEqual({ enabled: false, previews_enabled: true });
  });

  it('restores a legacy string entry with enabled:true only, leaving previews alone', async () => {
    vi.mocked(fetch).mockImplementation(okResp());
    const failed = await enableWorkers(env, ['legacy-app']);
    expect(failed).toEqual([]);
    expect(posts().map((p) => p.body)).toEqual([{ enabled: true }]);
  });

  it('returns the failed entries unchanged instead of throwing', async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 404, message: 'not found' }] }),
          { status: 404 },
        ),
      ),
    );
    const record = { script: 'gone-script', enabled: true, previewsEnabled: true };
    await expect(enableWorkers(env, [record, 'legacy-gone'])).resolves.toEqual([
      record,
      'legacy-gone',
    ]);
  });
});

describe('resolveWorkerTargets', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const explicit = (...names: string[]): AppConfig => ({
    ...BASE_CFG,
    blocking: { ...BASE_CFG.blocking, workers: names },
  });

  it('records original values and skips scripts that are not exposed', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        exposure: {
          pub: { enabled: true, previews_enabled: true },
          'cron-only': { enabled: false, previews_enabled: false },
          'previews-only': { enabled: false, previews_enabled: true },
          'main-only': { enabled: true, previews_enabled: false },
        },
      }),
    );
    const targets = await resolveWorkerTargets(
      env,
      explicit('pub', 'cron-only', 'previews-only', 'main-only'),
    );
    expect(targets).toEqual([
      { script: 'pub', enabled: true, previewsEnabled: true },
      { script: 'previews-only', enabled: false, previewsEnabled: true },
      { script: 'main-only', enabled: true, previewsEnabled: false },
    ]);
  });

  it('applies the same filter in all mode', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        scripts: ['exposed', 'private'],
        exposure: { private: { enabled: false, previews_enabled: false } },
      }),
    );
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    const targets = await resolveWorkerTargets(env, cfg);
    expect(targets.map((t) => t.script)).toEqual(['exposed']);
  });

  it('still records a script whose GET fails, assuming only the main subdomain was on', async () => {
    vi.stubGlobal('fetch', routedFetch({ getFails: ['flaky'] }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const targets = await resolveWorkerTargets(env, explicit('flaky'));
    errSpy.mockRestore();
    expect(targets).toEqual([{ script: 'flaky', enabled: true, previewsEnabled: false }]);
  });

  it('skips a script that does not exist (GET 404)', async () => {
    vi.stubGlobal('fetch', routedFetch({ getStatus: { ghost: 404 } }));
    await expect(resolveWorkerTargets(env, explicit('ghost'))).resolves.toEqual([]);
  });

  it('does not mutate anything — discovery is read-only', async () => {
    vi.stubGlobal('fetch', routedFetch({ scripts: ['user-app'] }));
    const cfg: AppConfig = { ...BASE_CFG, blocking: { ...BASE_CFG.blocking, workers: 'all' } };
    await resolveWorkerTargets(env, cfg);
    expect(posts()).toHaveLength(0);
  });
});

describe('mergeWorkerRecords', () => {
  it('never overwrites an existing record with a re-resolved one', () => {
    const merged = mergeWorkerRecords(
      [{ script: 'a', enabled: true, previewsEnabled: true }, 'legacy'],
      [
        { script: 'a', enabled: false, previewsEnabled: false },
        { script: 'legacy', enabled: false, previewsEnabled: false },
        { script: 'new', enabled: true, previewsEnabled: false },
      ],
    );
    expect(merged).toEqual([
      { script: 'a', enabled: true, previewsEnabled: true },
      'legacy',
      { script: 'new', enabled: true, previewsEnabled: false },
    ]);
  });
});
