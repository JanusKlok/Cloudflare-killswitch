import type { AppConfig } from './types.js';

// ---------------------------------------------------------------------------
// Kill Switch Configuration
// Edit the values below before deploying.  All limits are set to Cloudflare's
// Free Tier defaults.  Do NOT change the structure — only the numeric values
// and the purgeConfig arrays.
// ---------------------------------------------------------------------------
export const CONFIG: AppConfig = {
  // 'zone'    — blocks traffic on the single zone configured via CLOUDFLARE_ZONE_ID.
  //             Works on the Free plan. Recommended for most users.
  // 'account' — blocks traffic account-wide via the Account WAF.
  //             REQUIRES a paid Cloudflare plan.
  scope: 'zone',

  // Automatically restore on the 1st of each calendar month (UTC).
  autoResetOnFirstOfMonth: true,

  // Expose POST /restore so you can re-arm without touching the dashboard.
  enableRecoveryWebhook: true,

  limits: {
    workers: {
      // Free tier: 100,000 requests / day
      requests: { blockAt: 100_000 },
    },

    pages: {
      // Free tier: 100,000 Pages Functions invocations / day
      requests: { blockAt: 100_000 },
    },

    kv: {
      // Free tier: 100,000 reads / day
      reads: { blockAt: 100_000 },
      // Free tier: 1,000 writes / day
      writes: { blockAt: 1_000 },
      // Free tier: 1 GB storage (1,073,741,824 bytes)
      storageBytes: { blockAt: 1_073_741_824 },
    },

    r2: {
      // Free tier: 10 GB storage / month (10,737,418,240 bytes)
      storageBytes: { blockAt: 10_737_418_240 },
      // Free tier: 1,000,000 Class A operations / month
      classAOps: { blockAt: 1_000_000 },
      // Free tier: 10,000,000 Class B operations / month
      classBOps: { blockAt: 10_000_000 },
    },

    d1: {
      // Free tier: 5,000,000 row reads / day
      rowReads: { blockAt: 5_000_000 },
      // Free tier: 100,000 row writes / day
      rowWrites: { blockAt: 100_000 },
      // Free tier: 5 GB storage / month (5,368,709,120 bytes)
      storageBytes: { blockAt: 5_368_709_120 },
    },
  },

  blocking: {
    // -----------------------------------------------------------------------
    // workers — Workers scripts to disable on kill.
    //
    // 'all'     → auto-discover every deployed script and disable it except
    //             the kill-switch Worker itself (safe on the free plan).
    // string[]  → explicit list of script names to disable.
    // []        → do not touch any Workers scripts (default, safest).
    // -----------------------------------------------------------------------
    workers: [] as string[],

    // -----------------------------------------------------------------------
    // pages — Pages projects to block on kill.
    // A temporary 503 Worker is deployed to each project.
    // The original deployment is restored on recovery.
    //
    // 'all'    → auto-discover every Pages project on the account.
    // string[] → explicit list of project names.
    // []       → do not touch any Pages projects (default, safest).
    // -----------------------------------------------------------------------
    pages: [] as string[],
  },

  purgeConfig: {
    // -----------------------------------------------------------------------
    // R2 purge — OPTIONAL.  Only runs when a storage metric exceeds purgeAt.
    // Add one entry per bucket you want to purge.
    //
    // Example (uncomment and fill in real values):
    // {
    //   bindingName: 'MY_UPLOADS_BUCKET',  // must match wrangler.toml binding
    //   prefixes: ['uploads/'],            // [] = entire bucket
    //   deleteOrder: 'newest',             // 'newest' | 'oldest'
    //   // To enable purge, add purgeAt to the r2.storageBytes threshold above:
    //   //   storageBytes: { blockAt: 10_737_418_240, purgeAt: 11_000_000_000 }
    // },
    // -----------------------------------------------------------------------
    r2: [],

    // -----------------------------------------------------------------------
    // D1 purge — OPTIONAL.  Only runs when a storage metric exceeds purgeAt.
    // Add one entry per database you want to purge.
    //
    // Example (uncomment and fill in real values):
    // {
    //   bindingName: 'MY_APP_DB',   // must match wrangler.toml binding
    //   tables: [
    //     { name: 'events', action: 'DELETE_ALL' }, // empties the table
    //     { name: 'cache',  action: 'DROP' },       // drops the table entirely
    //   ],
    //   // To enable purge, add purgeAt to d1.storageBytes above:
    //   //   storageBytes: { blockAt: 5_368_709_120, purgeAt: 5_500_000_000 }
    // },
    // -----------------------------------------------------------------------
    d1: [],
  },
};
