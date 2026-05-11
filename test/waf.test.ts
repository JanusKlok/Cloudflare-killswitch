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

  it('uses (true) expression when webhook disabled', async () => {
    const cfg: AppConfig = { ...testCfg, enableRecoveryWebhook: false };
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(makeRulesetResponse('rs-4', 'rule-4')), { status: 200 })),
    );
    await deployBlockRule(env, cfg);

    const body = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string) as { expression: string };
    expect(body.expression).toBe('(true)');
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
