import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { fetchRetry } from '../src/util/retry.js';
import { CfApiError, cfFetch } from '../src/util/cf-api.js';
import { gql } from '../src/graphql/client.js';
import { purgeD1 } from '../src/actions/purge-d1.js';
import { sendAlert } from '../src/actions/email.js';
import type { D1PurgeTarget } from '../src/types.js';

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchRetry', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns a success response without retrying', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ ok: true }));
    const res = await fetchRetry('https://example.com');
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503, 504])('retries a %i once, then returns it', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('gateway', { status }));
    const res = await fetchRetry('https://example.com');
    expect(res.status).toBe(status);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx — the request itself is wrong', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 403 }));
    await fetchRetry('https://example.com');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('retries a network error and succeeds on the second attempt', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(ok({ ok: true }));
    const res = await fetchRetry('https://example.com');
    expect(res.status).toBe(200);
  });

  it('rethrows the last network error once attempts are exhausted', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection reset'));
    await expect(fetchRetry('https://example.com')).rejects.toThrow('connection reset');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

describe('cfFetch', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns the envelope result on success', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ success: true, errors: [], result: { id: 'x' } }));
    await expect(cfFetch<{ id: string }>('tok', '/whatever')).resolves.toEqual({ id: 'x' });
  });

  it('sends the bearer token and a JSON content type', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ success: true, errors: [], result: {} }));
    await cfFetch('tok', '/whatever', { method: 'POST', body: '{}' });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits the JSON content type for a FormData body, which sets its own boundary', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ success: true, errors: [], result: {} }));
    const form = new FormData();
    form.append('a', 'b');
    await cfFetch('tok', '/whatever', { method: 'POST', body: form });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('Content-Type');
  });

  it('exposes the status and error codes on failure', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({ success: false, errors: [{ code: 10005, message: 'gone' }] }, 404),
    );
    const err = await cfFetch('tok', '/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CfApiError);
    expect((err as CfApiError).status).toBe(404);
    expect((err as CfApiError).codes).toEqual([10005]);
    expect((err as CfApiError).isNotFound).toBe(true);
  });

  it('is not "not found" for an auth failure — callers create resources on that flag', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({ success: false, errors: [{ code: 10000, message: 'bad token' }] }, 403),
    );
    const err = (await cfFetch('tok', '/x').catch((e: unknown) => e)) as CfApiError;
    expect(err.isNotFound).toBe(false);
  });

  it('turns a non-JSON body into a CfApiError rather than a SyntaxError', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    );
    const err = (await cfFetch('tok', '/x').catch((e: unknown) => e)) as CfApiError;
    expect(err).toBeInstanceOf(CfApiError);
    expect(err.status).toBe(502);
    expect(err.isNotFound).toBe(false);
  });

  it('tolerates a failure envelope with no errors array', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ success: false, result: null }, 400));
    await expect(cfFetch('tok', '/x')).rejects.toThrow(/unknown error/);
  });
});

describe('gql', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns the data payload', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ data: { viewer: null } }));
    await expect(gql(env, 'query {}', {})).resolves.toEqual({ viewer: null });
  });

  it('throws on a GraphQL errors array even with HTTP 200', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ errors: [{ message: 'bad field' }] }));
    await expect(gql(env, 'query {}', {})).rejects.toThrow(/bad field/);
  });

  it('throws on a non-2xx response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(gql(env, 'query {}', {})).rejects.toThrow(/HTTP 401/);
  });

  it('throws when the response carries neither data nor errors', async () => {
    vi.mocked(fetch).mockResolvedValue(ok({}));
    await expect(gql(env, 'query {}', {})).rejects.toThrow(/no data/);
  });
});

describe('purgeD1', () => {
  function fakeDb(onSql: (sql: string) => void, failOn?: string) {
    return {
      prepare(sql: string) {
        return {
          run: async () => {
            onSql(sql);
            if (failOn && sql.includes(failOn)) throw new Error('table locked');
            return { success: true };
          },
        };
      },
    };
  }

  it('refuses a placeholder binding name', async () => {
    const target: D1PurgeTarget = { bindingName: 'REPLACE_ME_D1_BINDING', tables: [] };
    await expect(purgeD1(env, target)).rejects.toThrow(/placeholder/);
  });

  it('refuses a binding that is not on env', async () => {
    const target: D1PurgeTarget = { bindingName: 'NOPE_DB', tables: [] };
    await expect(purgeD1(env, target)).rejects.toThrow(/not found on env/);
  });

  it('runs DELETE and DROP in the configured order', async () => {
    const sqls: string[] = [];
    const target: D1PurgeTarget = {
      bindingName: 'MY_DB',
      tables: [
        { name: 'events', action: 'DELETE_ALL' },
        { name: 'cache', action: 'DROP' },
      ],
    };
    const result = await purgeD1(
      { ...env, MY_DB: fakeDb((s) => sqls.push(s)) } as unknown as typeof env,
      target,
    );

    expect(sqls).toEqual(['DELETE FROM `events`', 'DROP TABLE IF EXISTS `cache`']);
    expect(result.tableResults.every((t) => t.success)).toBe(true);
  });

  it('records a per-table failure and still processes later tables', async () => {
    const target: D1PurgeTarget = {
      bindingName: 'MY_DB',
      tables: [
        { name: 'locked', action: 'DELETE_ALL' },
        { name: 'fine', action: 'DELETE_ALL' },
      ],
    };
    const result = await purgeD1(
      { ...env, MY_DB: fakeDb(() => {}, 'locked') } as unknown as typeof env,
      target,
    );

    expect(result.tableResults[0]?.success).toBe(false);
    expect(result.tableResults[0]?.error).toContain('table locked');
    expect(result.tableResults[1]?.success).toBe(true);
  });
});

describe('sendAlert', () => {
  // EmailMessage is a Workers runtime global that only exists when a
  // [[send_email]] binding is configured, and wrangler.toml.example ships that
  // block commented out. Stub it so these tests can exercise the real path.
  class FakeEmailMessage {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: ReadableStream,
    ) {}
  }

  beforeEach(() => vi.stubGlobal('EmailMessage', FakeEmailMessage));
  afterEach(() => vi.unstubAllGlobals());

  it('no-ops when the SEND_EMAIL binding is absent', async () => {
    // Email is fully optional; a missing binding must not throw mid-kill.
    await expect(sendAlert(env, 'subject', 'body')).resolves.toBeUndefined();
  });

  it('no-ops when the binding exists but the address vars do not', async () => {
    const send = vi.fn();
    const envWithBinding = {
      ...env,
      SEND_EMAIL: { send },
      EMAIL_FROM: undefined,
      EMAIL_TO: undefined,
    } as unknown as typeof env;
    await sendAlert(envWithBinding, 'subject', 'body');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends when the binding and both address vars are present', async () => {
    const send = vi.fn();
    const envWithEmail = {
      ...env,
      EMAIL_FROM: 'from@example.com',
      EMAIL_TO: 'to@example.com',
      SEND_EMAIL: { send },
    } as unknown as typeof env;

    await sendAlert(envWithEmail, 'subject', 'body');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('strips CR/LF from the subject so extra headers cannot be injected', async () => {
    const sent: { raw: string }[] = [];
    const envWithEmail = {
      ...env,
      EMAIL_FROM: 'from@example.com',
      EMAIL_TO: 'to@example.com',
      SEND_EMAIL: {
        send: async (message: { raw: ReadableStream }) => {
          sent.push({ raw: await new Response(message.raw).text() });
        },
      },
    } as unknown as typeof env;

    await sendAlert(envWithEmail, 'hi\r\nBcc: attacker@example.com', 'body');

    const raw = sent[0]?.raw ?? '';
    expect(raw).toContain('Subject: hi Bcc: attacker@example.com');
    expect(raw).not.toMatch(/^Bcc:/m);
  });
});
