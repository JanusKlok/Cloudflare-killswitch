import { cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: cloudflarePool({
      wrangler: { configPath: './wrangler.toml.example' },
      // Top-level miniflare options override/extend the main worker from wrangler.toml.
      // Secrets and optional vars are provided here so tests work without a real account.
      miniflare: {
        // Pins the compatibility date of the pool's own test-runner worker,
        // NOT of the worker under test -- that one keeps the date from
        // wrangler.toml.example, so tests exercise real deployment semantics.
        // Required: without it the runner defaults to "today", which can
        // exceed the newest date the installed workerd binary supports (they
        // lag a few days behind the calendar) and every test fails with
        // ERR_RUNTIME_FAILURE. Bump alongside the wrangler devDependency.
        compatibilityDate: '2026-06-01',
        bindings: {
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          CLOUDFLARE_ACCOUNT_ID: 'test-account-id',
          CLOUDFLARE_ZONE_ID: 'test-zone-id',
          RECOVERY_SECRET: 'test-recovery-secret',
          WORKER_SELF_NAME: 'cloudflare-killswitch',
          EMAIL_FROM: 'test@example.com',
          EMAIL_TO: 'dest@example.com',
        },
        kvNamespaces: ['KILL_SWITCH_STATE'],
      },
    }),
  },
});
