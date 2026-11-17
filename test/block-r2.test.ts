import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { urlOf } from './helpers.js';
import {
  disableR2PublicAccess,
  mergeR2Records,
  resolveR2Targets,
  restoreR2PublicAccess,
} from '../src/actions/block-r2.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

function cfgWith(r2: 'all' | string[] | undefined): AppConfig {
  return { ...CONFIG, blocking: { ...CONFIG.blocking, r2 } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function ok(result: unknown) {
  return json({ success: true, errors: [], result });
}

function fail(status: number) {
  return json({ success: false, errors: [{ code: status, message: 'x' }] }, status);
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

interface Routes {
  /** bucket name -> jurisdiction it lives in */
  buckets: Record<string, string>;
  /** buckets whose r2.dev URL is on */
  publicOn: string[];
  getFails?: string[];
  putFails?: string[];
}

function routedFetch(routes: Routes) {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    const jurisdiction = headerOf(init, 'cf-r2-jurisdiction') ?? 'default';
    const managed = /\/r2\/buckets\/([^/]+)\/domains\/managed$/.exec(url.pathname);
    if (managed) {
      const name = decodeURIComponent(managed[1] ?? '');
      if (init?.method === 'PUT') {
        return routes.putFails?.includes(name) ? fail(500) : ok({ enabled: true });
      }
      if (routes.getFails?.includes(name)) return fail(400);
      if (routes.buckets[name] !== jurisdiction) return fail(404);
      return ok({ enabled: routes.publicOn.includes(name) });
    }
    const after = url.searchParams.get('start_after');
    const names = Object.keys(routes.buckets)
      .filter((n) => routes.buckets[n] === jurisdiction)
      .sort()
      .filter((n) => !after || n > after)
      .slice(0, 1000);
    return ok({ buckets: names.map((name) => ({ name, jurisdiction })) });
  });
}

function puts() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === 'PUT')
    .map(([input, init]) => ({
      url: urlOf(input),
      body: JSON.parse((init as RequestInit).body as string) as { enabled: boolean },
      jurisdiction: headerOf(init as RequestInit, 'cf-r2-jurisdiction'),
    }));
}

describe('block-r2', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing when r2 is absent or empty', async () => {
    expect(await resolveR2Targets(env, cfgWith(undefined))).toEqual([]);
    expect(await resolveR2Targets(env, cfgWith([]))).toEqual([]);
    expect(await disableR2PublicAccess(env, [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records only buckets whose r2.dev URL is on', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ buckets: { pub: 'default', priv: 'default' }, publicOn: ['pub'] }),
    );
    expect(await resolveR2Targets(env, cfgWith(['pub', 'priv']))).toEqual([{ bucket: 'pub' }]);
  });

  it('skips a bucket that does not exist', async () => {
    vi.stubGlobal('fetch', routedFetch({ buckets: {}, publicOn: [] }));
    expect(await resolveR2Targets(env, cfgWith(['ghost']))).toEqual([]);
  });

  it("'all' lists every bucket across pages and jurisdictions", async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        buckets: { a: 'default', b: 'default', c: 'default', e: 'eu' },
        publicOn: ['a', 'b', 'c', 'e'],
      }),
    );
    const targets = await resolveR2Targets(env, cfgWith('all'));
    expect(targets.map((t) => t.bucket).sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(targets.find((t) => t.bucket === 'e')).toEqual({ bucket: 'e', jurisdiction: 'eu' });
    expect(targets.find((t) => t.bucket === 'a')).toEqual({ bucket: 'a' });
  });

  it('pages the bucket list with start_after until a short page', async () => {
    const names = Array.from({ length: 1001 }, (_, i) => `b${String(i).padStart(4, '0')}`);
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(urlOf(input));
        if (url.pathname.endsWith('domains/managed')) return ok({ enabled: false });
        if (headerOf(init, 'cf-r2-jurisdiction')) return ok({ buckets: [] });
        const after = url.searchParams.get('start_after');
        const page = names.filter((n) => !after || n > after).slice(0, 1000);
        return ok({ buckets: page.map((name) => ({ name, jurisdiction: 'default' })) });
      });
    vi.stubGlobal('fetch', fetchMock);
    await resolveR2Targets(env, cfgWith('all'));
    const listCalls = fetchMock.mock.calls
      .map(([i]) => new URL(urlOf(i as RequestInfo | URL)))
      .filter((u) => u.pathname.endsWith('/r2/buckets'));
    expect(listCalls.some((u) => u.searchParams.get('start_after') === 'b0999')).toBe(true);
  });

  it('finds an explicitly named bucket in a non-default jurisdiction', async () => {
    vi.stubGlobal('fetch', routedFetch({ buckets: { eub: 'eu' }, publicOn: ['eub'] }));
    expect(await resolveR2Targets(env, cfgWith(['eub']))).toEqual([
      { bucket: 'eub', jurisdiction: 'eu' },
    ]);
  });

  it('blocks a bucket anyway when its state cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ buckets: { x: 'default' }, publicOn: [], getFails: ['x'] }),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await resolveR2Targets(env, cfgWith(['x']))).toEqual([
      { bucket: 'x', priorStateUnknown: true },
    ]);
    errSpy.mockRestore();
  });

  it('skips already-recorded buckets before any GET, explicit and all', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ buckets: { a: 'default', b: 'default' }, publicOn: ['a', 'b'] }),
    );
    expect(await resolveR2Targets(env, cfgWith(['a', 'b']), new Set(['a']))).toEqual([
      { bucket: 'b' },
    ]);
    const gets = () =>
      vi.mocked(fetch).mock.calls.filter(([i]) => urlOf(i).includes('domains/managed'));
    expect(gets().every(([i]) => !urlOf(i).includes('/buckets/a/'))).toBe(true);
    vi.mocked(fetch).mockClear();
    expect(await resolveR2Targets(env, cfgWith('all'), new Set(['a', 'b']))).toEqual([]);
    expect(gets()).toHaveLength(0);
  });

  it('disable PUTs enabled:false with the jurisdiction header and returns successes', async () => {
    vi.stubGlobal('fetch', routedFetch({ buckets: {}, publicOn: [], putFails: ['bad'] }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const done = await disableR2PublicAccess(env, [
      { bucket: 'good' },
      { bucket: 'eub', jurisdiction: 'eu' },
      { bucket: 'bad' },
    ]);
    errSpy.mockRestore();
    expect(done.map((d) => d.bucket)).toEqual(['good', 'eub']);
    const sent = puts();
    expect(sent.every((p) => !p.body.enabled)).toBe(true);
    expect(sent.find((p) => p.url.includes('/r2/buckets/eub/'))?.jurisdiction).toBe('eu');
    expect(sent.find((p) => p.url.includes('/r2/buckets/good/'))?.jurisdiction).toBeUndefined();
  });

  it('restore re-enables only recorded buckets and returns the failures', async () => {
    vi.stubGlobal('fetch', routedFetch({ buckets: {}, publicOn: [], putFails: ['bad'] }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { failed, skipped } = await restoreR2PublicAccess(env, [
      { bucket: 'good' },
      { bucket: 'bad' },
      { bucket: 'unk', priorStateUnknown: true },
    ]);
    errSpy.mockRestore();
    expect(failed).toEqual([{ bucket: 'bad' }]);
    expect(skipped).toEqual([{ bucket: 'unk', priorStateUnknown: true }]);
    expect(puts()).toHaveLength(2);
    expect(puts().every((p) => p.body.enabled)).toBe(true);
  });
});

describe('mergeR2Records', () => {
  it('keeps existing records and appends only new buckets', () => {
    const merged = mergeR2Records(
      [{ bucket: 'a', jurisdiction: 'eu' }],
      [{ bucket: 'a' }, { bucket: 'b' }],
    );
    expect(merged).toEqual([{ bucket: 'a', jurisdiction: 'eu' }, { bucket: 'b' }]);
  });
});
