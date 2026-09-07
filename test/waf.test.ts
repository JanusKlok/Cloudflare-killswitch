import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { deployBlockRule, removeBlockRule } from '../src/actions/waf.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const testCfg: AppConfig = { ...CONFIG, scope: 'zone', enableRecoveryWebhook: true };

// Minimal Cloudflare API mock responses
function makeRulesetResponse(rulesetId: string, ruleId: string) {
  return {
    success: true,
    errors: [],
    result: {
      id: rulesetId,
      phase: 'http_request_firewall_custom',
      rules: [{ id: ruleId }],
    },
  };
}

function makeAddRuleResponse(ruleId: string) {
  return { success: true, errors: [], result: { id: ruleId } };
}

describe('deployBlockRule', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates entrypoint ruleset when phase returns 404', async () => {
    const mockFetch = vi.mocked(fetch);
    // First call: GET entrypoint → 404
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [{ code: 10005, message: 'not found' }] }), { status: 404 }),
    );
    // Second call: PUT entrypoint → creates with rule
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(makeRulesetResponse('rs-1', 'rule-1')), { status: 200 }),
    );

    const result = await deployBlockRule(env, testCfg);
    expect(result.ruleId).toBe('rule-1');
    expect(result.rulesetId).toBe('rs-1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('appends rule to existing ruleset', async () => {
    const mockFetch = vi.mocked(fetch);
    // First call: GET entrypoint → exists
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(makeRulesetResponse('rs-2', 'existing-rule')), { status: 200 }),
    );
    // Second call: POST new rule
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(makeAddRuleResponse('rule-new')), { status: 200 }),
    );

    const result = await deployBlockRule(env, testCfg);
    expect(result.ruleId).toBe('rule-new');
    expect(result.rulesetId).toBe('rs-2');

    const postCall = mockFetch.mock.calls[1];
    expect(postCall?.[1]?.method).toBe('POST');
  });

  it('uses correct expression when webhook enabled', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(makeRulesetResponse('rs-3', 'rule-3')), { status: 200 })),
    );
    await deployBlockRule(env, testCfg);

    const body = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string) as { expression: string };
    expect(body.expression).toContain('/restore');
  });

  it('uses a field-based match-all expression when webhook disabled', async () => {
    const cfg: AppConfig = { ...testCfg, enableRecoveryWebhook: false };
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(makeRulesetResponse('rs-4', 'rule-4')), { status: 200 })),
    );
    await deployBlockRule(env, cfg);

    const body = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string) as { expression: string };
    // The rules language rejects bare boolean literals like (true).
    expect(body.expression).toBe('(ip.src ne 0.0.0.0)');
  });
});

describe('removeBlockRule', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('calls DELETE on the correct path', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true, errors: [], result: {} }), { status: 200 }),
    );
    await removeBlockRule(env, testCfg, 'rule-x', 'rs-x');
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/rules/rule-x');
    expect(url).toContain('/rulesets/rs-x');
  });

  it('does not throw when rule is already gone (10005)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 10005, message: 'rule not found' }] }),
        { status: 200 },
      ),
    );
    await expect(removeBlockRule(env, testCfg, 'gone', 'rs-x')).resolves.toBeUndefined();
  });
});

describe('deployBlockRule — destructive-fallback guard', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  /** The PUT fallback replaces a ruleset's ENTIRE rules array, so it may only
   *  run on a definite 404. Each case below would previously have wiped every
   *  custom rule the operator had. */
  const nonNotFound = [
    ['403 bad token', 403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }],
    ['429 rate limited', 429, { success: false, errors: [{ code: 971, message: 'rate limited' }] }],
    ['200 with success:false', 200, { success: false, errors: [{ code: 1, message: 'nope' }] }],
  ] as const;

  it.each(nonNotFound)('refuses to PUT the entrypoint on %s', async (_label, status, body) => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));

    await expect(deployBlockRule(env, testCfg)).rejects.toThrow();

    const puts = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(puts).toHaveLength(0);
  });

  it('refuses to PUT the entrypoint when a 502 returns a non-JSON body', async () => {
    const mockFetch = vi.mocked(fetch);
    // fetchRetry returns the 502 after exhausting retries rather than throwing,
    // so res.json() raised a SyntaxError that the old bare catch swallowed.
    mockFetch.mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(deployBlockRule(env, testCfg)).rejects.toThrow(/non-JSON 502/);
    const puts = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(puts).toHaveLength(0);
  });

  it('still creates the entrypoint on a genuine 404', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10005, message: 'not found' }] }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeRulesetResponse('rs-new', 'rule-new')), { status: 200 }),
      );

    const result = await deployBlockRule(env, testCfg);
    expect(result).toEqual({ ruleId: 'rule-new', rulesetId: 'rs-new' });
  });
});

describe('deployBlockRule — rule creation is not retried', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  function urlOf(input: RequestInfo | URL): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  }

  it('does not POST /rules twice on a 502 — a second rule would be orphaned', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('rulesets/phases')) {
        return new Response(JSON.stringify(makeRulesetResponse('rs-1', 'other-rule')), {
          status: 200,
        });
      }
      if (init?.method === 'POST') return new Response('<html>bad gateway</html>', { status: 502 });
      // Reconciliation lookup: no rule of ours present.
      return new Response(
        JSON.stringify({ success: true, errors: [], result: { id: 'rs-1', phase: 'x', rules: [] } }),
        { status: 200 },
      );
    });

    await expect(deployBlockRule(env, testCfg)).rejects.toThrow();

    const creates = mockFetch.mock.calls.filter(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method === 'POST' && urlOf(input).endsWith('/rules'),
    );
    expect(creates).toHaveLength(1);
  });

  it('adopts an already-created rule when the create response was lost', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes('rulesets/phases')) {
        return new Response(JSON.stringify(makeRulesetResponse('rs-1', 'other-rule')), {
          status: 200,
        });
      }
      if (init?.method === 'POST') return new Response('<html>gateway</html>', { status: 502 });
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            id: 'rs-1',
            phase: 'http_request_firewall_custom',
            rules: [
              { id: 'unrelated', description: "operator's own rule" },
              { id: 'ours', description: 'Kill Switch — automated traffic block' },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const result = await deployBlockRule(env, testCfg);
    expect(result).toEqual({ ruleId: 'ours', rulesetId: 'rs-1' });
  });
});

describe('removeBlockRule — error classification', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('rethrows a real failure instead of reporting the block lifted', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
        { status: 403 },
      ),
    );
    await expect(removeBlockRule(env, testCfg, 'r', 'rs')).rejects.toThrow();
  });

  it('does not mistake a rule id containing "404" for a not-found response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'boom' }] }), {
        status: 500,
      }),
    );
    await expect(removeBlockRule(env, testCfg, 'abc404def', 'rs')).rejects.toThrow();
  });
});

describe('block expression', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  async function capturedRule(cfg: AppConfig, selfHostname?: string) {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeRulesetResponse('rs', 'existing')), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeAddRuleResponse('new')), { status: 200 }),
      );
    await deployBlockRule(env, cfg, selfHostname);
    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    return JSON.parse(init.body as string) as { expression: string };
  }

  it('scopes the /restore exemption to the recovery hostname when known', async () => {
    const rule = await capturedRule(testCfg, 'ks.example.workers.dev');
    expect(rule.expression).toContain('http.host eq "ks.example.workers.dev"');
  });

  it('falls back to a path-only exemption when no hostname is configured', async () => {
    const rule = await capturedRule(testCfg);
    expect(rule.expression).toBe(
      'not (http.request.method eq "POST" and http.request.uri.path eq "/restore")',
    );
  });

  it('blocks everything when the recovery webhook is disabled', async () => {
    const rule = await capturedRule({ ...testCfg, enableRecoveryWebhook: false });
    expect(rule.expression).toBe('(ip.src ne 0.0.0.0)');
  });
});
