import { describe, it, expect } from 'vitest';
import { parseWranglerToml, validate, type Issue } from '../scripts/validate-lib.js';
import { CONFIG } from '../src/config.js';
import type { AppConfig } from '../src/types.js';

const GOOD_TOML = `
name = "cloudflare-killswitch"
main = "src/index.ts"

[triggers]
crons = ["*/5 * * * *"]

[[kv_namespaces]]
binding = "KILL_SWITCH_STATE"
id = "0123456789abcdef0123456789abcdef"

[vars]
CLOUDFLARE_ACCOUNT_ID = "aaaabbbbccccddddeeeeffff00001111"
CLOUDFLARE_ZONE_ID = "1111222233334444"
WORKER_SELF_NAME = "cloudflare-killswitch"
`;

function cfgWith(overrides: Partial<AppConfig>): AppConfig {
  return { ...CONFIG, ...overrides };
}

function errors(issues: Issue[]): string[] {
  return issues.filter((i) => i.level === 'error').map((i) => i.title);
}
function warnings(issues: Issue[]): string[] {
  return issues.filter((i) => i.level === 'warning').map((i) => i.title);
}

describe('parseWranglerToml', () => {
  it('extracts name, vars, kv ids, and skips commented-out blocks', () => {
    const info = parseWranglerToml(GOOD_TOML + '\n# [[send_email]]\n# destination_address = "x@y.z"\n');
    expect(info.workerName).toBe('cloudflare-killswitch');
    expect(info.vars['CLOUDFLARE_ACCOUNT_ID']).toBe('aaaabbbbccccddddeeeeffff00001111');
    expect(info.kvNamespaceIds).toEqual(['0123456789abcdef0123456789abcdef']);
    expect(info.hasSendEmail).toBe(false);
  });

  it('detects an active send_email block and its destination', () => {
    const info = parseWranglerToml(GOOD_TOML + '\n[[send_email]]\nname = "SEND_EMAIL"\ndestination_address = "me@example.com"\n');
    expect(info.hasSendEmail).toBe(true);
    expect(info.sendEmailDestination).toBe('me@example.com');
  });

  it('collects r2 and d1 binding names', () => {
    const info = parseWranglerToml(GOOD_TOML + '\n[[r2_buckets]]\nbinding = "MY_BUCKET"\nbucket_name = "b"\n\n[[d1_databases]]\nbinding = "MY_DB"\ndatabase_id = "d"\n');
    expect(info.r2Bindings).toEqual(['MY_BUCKET']);
    expect(info.d1Bindings).toEqual(['MY_DB']);
  });
});

describe('validate — scope', () => {
  it("errors when scope 'zone' has an empty zone ID", () => {
    const toml = GOOD_TOML.replace('CLOUDFLARE_ZONE_ID = "1111222233334444"', 'CLOUDFLARE_ZONE_ID = ""');
    const issues = validate(cfgWith({ scope: 'zone' }), parseWranglerToml(toml));
    expect(errors(issues).join(' ')).toContain('CLOUDFLARE_ZONE_ID');
  });

  it("passes when scope 'zone' has a real zone ID", () => {
    const issues = validate(cfgWith({ scope: 'zone' }), parseWranglerToml(GOOD_TOML));
    expect(errors(issues)).toEqual([]);
  });

  it("warns that scope 'account' is Enterprise-only", () => {
    const issues = validate(cfgWith({ scope: 'account' }), parseWranglerToml(GOOD_TOML));
    expect(warnings(issues).join(' ')).toContain('Enterprise');
  });

  it("errors when scope 'none' has no blocking configured", () => {
    const cfg = cfgWith({ scope: 'none', blocking: { ...CONFIG.blocking, workers: [], pages: [] } });
    const issues = validate(cfg, parseWranglerToml(GOOD_TOML));
    expect(errors(issues).join(' ')).toContain('no action');
  });

  it("passes when scope 'none' blocks workers", () => {
    const cfg = cfgWith({ scope: 'none', blocking: { ...CONFIG.blocking, workers: 'all', pages: [] } });
    const issues = validate(cfg, parseWranglerToml(GOOD_TOML));
    expect(errors(issues)).toEqual([]);
  });
});

describe('validate — email', () => {
  it('errors on an active send_email block with a placeholder destination (deploy would fail)', () => {
    const toml = GOOD_TOML + '\n[[send_email]]\nname = "SEND_EMAIL"\ndestination_address = "REPLACE_ME_WITH_DESTINATION_EMAIL"\n';
    const issues = validate(cfgWith({ scope: 'zone' }), parseWranglerToml(toml));
    expect(errors(issues).join(' ')).toContain('destination_address');
  });

  it('warns when send_email is active but EMAIL vars are missing', () => {
    const toml = GOOD_TOML + '\n[[send_email]]\nname = "SEND_EMAIL"\ndestination_address = "me@example.com"\n';
    const issues = validate(cfgWith({ scope: 'zone' }), parseWranglerToml(toml));
    expect(warnings(issues).join(' ')).toContain('EMAIL_FROM');
  });

  it('warns when EMAIL vars are set but send_email is commented out', () => {
    const toml = GOOD_TOML + 'EMAIL_FROM = "a@b.c"\nEMAIL_TO = "d@e.f"\n';
    const issues = validate(cfgWith({ scope: 'zone' }), parseWranglerToml(toml));
    expect(warnings(issues).join(' ')).toContain('commented out');
  });
});

describe('validate — identifiers', () => {
  it('errors on placeholder account ID and KV namespace id', () => {
    const toml = GOOD_TOML
      .replace('id = "0123456789abcdef0123456789abcdef"', 'id = "REPLACE_ME_WITH_YOUR_KV_NAMESPACE_ID"')
      .replace('CLOUDFLARE_ACCOUNT_ID = "aaaabbbbccccddddeeeeffff00001111"', 'CLOUDFLARE_ACCOUNT_ID = "REPLACE_ME_WITH_YOUR_ACCOUNT_ID"');
    const issues = validate(cfgWith({ scope: 'zone' }), parseWranglerToml(toml));
    expect(errors(issues).some((t) => t.includes('CLOUDFLARE_ACCOUNT_ID'))).toBe(true);
    expect(errors(issues).some((t) => t.includes('KV namespace'))).toBe(true);
  });

  it("errors when WORKER_SELF_NAME mismatches and blocking.workers is 'all' (would disable itself)", () => {
    const toml = GOOD_TOML.replace('WORKER_SELF_NAME = "cloudflare-killswitch"', 'WORKER_SELF_NAME = "wrong-name"');
    const cfg = cfgWith({ scope: 'zone', blocking: { ...CONFIG.blocking, workers: 'all', pages: [] } });
    const issues = validate(cfg, parseWranglerToml(toml));
    expect(errors(issues).join(' ')).toContain('WORKER_SELF_NAME');
  });
});

describe('validate — purge', () => {
  it('errors when purgeAt is below blockAt', () => {
    const cfg = cfgWith({
      scope: 'zone',
      limits: { ...CONFIG.limits, r2: { ...CONFIG.limits.r2, storageBytes: { blockAt: 100, purgeAt: 50 } } },
    });
    const issues = validate(cfg, parseWranglerToml(GOOD_TOML));
    expect(errors(issues).join(' ')).toContain('purgeAt');
  });

  it('errors when a purge target has no matching wrangler.toml binding', () => {
    const cfg = cfgWith({
      scope: 'zone',
      limits: { ...CONFIG.limits, r2: { ...CONFIG.limits.r2, storageBytes: { blockAt: 100, purgeAt: 200 } } },
      purgeConfig: { r2: [{ bindingName: 'MISSING_BUCKET', prefixes: [], deleteOrder: 'newest' }], d1: [] },
    });
    const issues = validate(cfg, parseWranglerToml(GOOD_TOML));
    expect(errors(issues).join(' ')).toContain('MISSING_BUCKET');
  });

  it('warns when purgeConfig is set but no threshold has purgeAt', () => {
    const toml = GOOD_TOML + '\n[[r2_buckets]]\nbinding = "MY_BUCKET"\nbucket_name = "b"\n';
    const cfg = cfgWith({
      scope: 'zone',
      purgeConfig: { r2: [{ bindingName: 'MY_BUCKET', prefixes: [], deleteOrder: 'newest' }], d1: [] },
    });
    const issues = validate(cfg, parseWranglerToml(toml));
    expect(warnings(issues).join(' ')).toContain('can never run');
  });
});

describe('validate — notes', () => {
  it('lists the API token permissions the configuration needs', () => {
    const cfg = cfgWith({ scope: 'zone', blocking: { ...CONFIG.blocking, workers: 'all', pages: 'all' } });
    const issues = validate(cfg, parseWranglerToml(GOOD_TOML));
    const notes = issues.filter((i) => i.level === 'note').flatMap((i) => [i.title, ...i.detail]).join('\n');
    expect(notes).toContain('Zone -> WAF: Edit');
    expect(notes).toContain('Workers Scripts: Edit');
    expect(notes).toContain('Cloudflare Pages: Edit');
  });
});
