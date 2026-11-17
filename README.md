# Cloudflare Kill Switch

[![CI](https://github.com/JanusKlok/Cloudflare-killswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/JanusKlok/Cloudflare-killswitch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](./package.json)

A Cloudflare Worker that monitors your usage on a configurable schedule and automatically blocks all traffic — with optional data purge and email or webhook alerts — the moment any configured limit is crossed.

When a limit is hit, the worker:

1. Deploys a WAF Custom Rule that blocks every incoming request
2. Disables the `workers.dev` subdomain and preview URLs for configured Workers scripts that expose them (optional)
3. Replaces the production deployment of configured Pages projects with an empty one, so they serve 404 (optional)
4. Turns off the public `r2.dev` URL of configured R2 buckets (optional)
5. Sends an alert with a full breach report, by email and/or webhook (optional)
6. Optionally purges R2 objects or D1 table data if storage crosses a higher, opt-in threshold
7. Writes state to KV, so later cron ticks only have to keep the block in place
8. Automatically re-arms itself once the quota that caused the kill has reset — at 00:00 UTC for daily quotas, or when your billing period opens for per-cycle limits

A recovery endpoint (`POST /restore`) lets you lift the block immediately without touching the Cloudflare dashboard.

No external services, no runtime dependencies. Runs entirely on Cloudflare infrastructure.

---

## Quick start

You need Node.js 22+ and pnpm (see [Prerequisites](#prerequisites)). Then:

```
git clone https://github.com/JanusKlok/Cloudflare-killswitch.git
cd Cloudflare-killswitch
pnpm install
.\setup.ps1                              # Windows (PowerShell)
bash setup.sh                            # macOS / Linux
pnpm exec wrangler tail --format pretty  # watch a cron tick (within 5 minutes)
```

The setup script checks your Wrangler login, creates the KV namespace, writes `wrangler.toml` and `src/config.ts`, sets secrets and offers to deploy. It does not cover everything: see [what the scripts do and don't cover](#automated-setup-recommended). A healthy tick shows status `Ok` and no log lines, see [Verifying it works](#verifying-it-works).

---

## Table of contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Automated setup](#automated-setup-recommended)
- [Manual setup](#manual-setup)
- [Configuration reference](#configuration-reference)
- [How this compares with Cloudflare Spend Management](#how-this-compares-with-cloudflare-spend-management)
- [Metrics and default limits](#metrics-and-default-limits)
- [Optional: alerts (email and webhook)](#optional-alerts-email-and-webhook)
- [Optional: Workers, Pages and R2 blocking](#optional-workers-pages-and-r2-blocking)
- [Optional: destructive purge](#optional-destructive-purge)
- [Recovery](#recovery)
- [Verifying it works](#verifying-it-works)
- [API token permissions](#api-token-permissions)
- [Upgrading from 2.0.0](#upgrading-from-200)
- [Local development and testing](#local-development-and-testing)
- [Extending: adding a new service](#extending-adding-a-new-service)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
On each cron tick (default: every 5 minutes, configurable in wrangler.toml):

  1. Read KV state

  2. Query Cloudflare GraphQL Analytics API for current usage across
     Workers, Pages, KV, R2, and D1 — one request for all of them, and on
     every tick, including while killed

  3. Compare every metric against its configured blockAt threshold

  4. State is 'active' and a threshold is breached:
       a. Deploy a WAF Custom Rule blocking all requests
          (with the recovery webhook on, POST /restore is exempted so you
          can still recover; see enableRecoveryWebhook)
       b. Look up which configured Workers scripts, Pages projects and R2
          buckets are exposed, and record them in KV BEFORE touching them
       c. Turn off workers.dev + preview URLs for the exposed Workers scripts,
          deploy an empty site to the Pages projects, turn off the r2.dev URL
          of the public R2 buckets
       d. If an R2 metric exceeds purgeAt: run the configured R2 purge actions;
          if a D1 metric exceeds purgeAt: run the configured D1 purge actions
          (destructive — opt-in only; other services never trigger purges)
       e. Send an alert (email and/or webhook) with breach details and all
          blocking results
       f. Write 'killed' state to KV (WAF rule ID, the pre-kill state of each
          Worker and R2 bucket, blocked Pages deployment IDs)

  5. State is 'killed':
       a. Auto-reset due (see autoResetOnBillingCycle) and nothing over a
          limit → undo everything recorded, set 'active', resume monitoring
          (due but still over a limit → stay killed)
       b. Otherwise keep the block in place: block Workers, Pages projects and
          R2 buckets created since the kill, retry blocks that failed, retry a
          WAF rule that never deployed, and run a purge — at most once per
          service — if purgeAt is reached after the kill. KV is written only
          when something changed; an alert is sent only when something new
          happened

POST /restore:
  1. Verify Authorization: Bearer <RECOVERY_SECRET>
  2. Roll back Pages projects to their pre-kill production deployments
  3. Write back each Worker's recorded workers.dev / preview-URL values
  4. Turn the r2.dev URL back on for buckets that were public before the kill
  5. Delete the WAF rule via the Cloudflare API
  6. Write 'active' state to KV (on partial failure the state stays
     'killed' with only the failed items, so a retry picks them up)
  7. Return { restored: true, previousReason: "..." }
```

State is a small JSON object in KV:

```json
{
  "status": "killed",
  "timestamp": "2026-05-08T14:32:00.000Z",
  "killedAt": "2026-05-08T14:32:00.000Z",
  "reason": "2 block breach(es)",
  "resetWindow": "day",
  "purgedServices": [],
  "wafRuleId": "abc123",
  "wafRulesetId": "def456",
  "disabledWorkerScripts": [
    { "script": "my-app-worker", "enabled": true, "previewsEnabled": false }
  ],
  "blockedPagesProjects": [
    { "project": "my-site", "previousDeploymentId": "deploy-abc123", "productionBranch": "main" }
  ],
  "blockedR2Buckets": [{ "bucket": "my-public-assets" }]
}
```

All IDs are stored so `POST /restore` can undo each action precisely — no manual dashboard work needed. Besides the fields above:

- `resetWindow` — `"day"` or `"cycle"`: which quota has to roll over before auto-reset is due (see [`autoResetOnBillingCycle`](#autoresetonbillingcycle)). Absent in states written by v2.0.0, which reset per billing cycle.
- `purgedServices` — services whose purge already ran during this kill, so it never runs twice. Absent in v2.0.0 states, which never purge on a later tick.
- `restorePending` — `true` when a restore only partly succeeded. The state stays `killed` with only the failed items, and later ticks retry the restore instead of re-blocking (see [Partial restore](#partial-restore)). v2.0.0 remnants have no flag and are recognised by a `reason` starting with `partial restore failure`.
- `pendingWorkerBlocks`, `pendingPagesBlocks`, `pendingR2Blocks` — recorded targets whose block call has not succeeded yet; retried on every tick.
- `blockedPagesProjects[].productionBranch` — the branch a retried kill deployment is pushed to.
- `blockedR2Buckets` — buckets whose `r2.dev` URL was on (with `jurisdiction` for non-default ones, and `priorStateUnknown` when the state could not be read).

---

## Prerequisites

- **A Cloudflare account.** A zone (a domain pointing to Cloudflare) is only needed for `scope: 'zone'` or `'account'`, where the WAF rule protects zones. With `scope: 'none'` no zone is needed
- **Node.js 22+** and **pnpm** (`npm install -g pnpm`)
- **Wrangler CLI** — installed automatically as a dev dependency; use `pnpm exec wrangler` or add it to your PATH

> **Free plan vs Enterprise:** The default `scope: 'zone'` in `config.ts` deploys WAF rules to a single zone and works on the **free plan**. Setting `scope: 'account'` deploys an account-wide WAF rule and **requires an Enterprise plan** (account-level custom rulesets are Enterprise-only). If your account has no domain at all (`workers.dev` / `pages.dev` only), use `scope: 'none'` together with `blocking.workers` / `blocking.pages`. Most users with a domain should leave this at `'zone'`.

---

## Automated setup (recommended)

The setup scripts handle the common path interactively: creating the KV namespace, filling in `wrangler.toml` and `src/config.ts`, setting secrets, and deploying. You just answer the prompts.

**Before running the script**, clone the repo and install dependencies (the script uses the local Wrangler, which `pnpm install` provides):

```
git clone https://github.com/JanusKlok/Cloudflare-killswitch.git
cd Cloudflare-killswitch
pnpm install
```

The script then checks whether you are logged in to Wrangler and starts `wrangler login` if not.

**macOS / Linux:**

```
bash setup.sh
```

**Windows (PowerShell):**

```
.\setup.ps1
```

The script asks for the WAF scope, Account ID, Zone ID (unless the scope is `none`), API token, recovery webhook (default: no), email addresses, which Workers scripts and Pages projects to block, and your billing cycle day. At the end it offers to deploy immediately.

**What the scripts do not cover.** Set these by hand afterwards:

- `blocking.r2`: see [`blocking`](#blocking) and [Block r2.dev public URLs](#block-r2dev-public-urls)
- Webhook alerts: set the `ALERT_WEBHOOK_URL` secret, see [Webhook setup](#webhook-setup)
- `RECOVERY_HOSTNAME`: see [Environment variables and secrets](#environment-variables-and-secrets)
- `limits.combined`: the script leaves the default from `config.example.ts` (100,000 requests per day), see [limits](#limits)
- Thresholds and purge: see [limits](#limits) and [Optional: destructive purge](#optional-destructive-purge)

> If you chose to generate a recovery secret automatically, the script prints it at the end. **Save it somewhere safe** — you will need it to call `POST /restore`.

---

## Manual setup

If you prefer full control over each step, or want to understand exactly what the script does, follow the instructions below.

**Required for any deployment:** steps 1–5 (code, dependencies, KV namespace, wrangler.toml placeholders, API token), plus creating `src/config.ts` from the template (the first part of step 6). Editing its values is optional, because the defaults work. Step 7 deploys.

| What | Required? |
|------|-----------|
| KV namespace + wrangler.toml placeholders | Yes |
| `src/config.ts` (copy of `src/config.example.ts`) | Yes |
| `CLOUDFLARE_API_TOKEN` secret | Yes |
| `RECOVERY_SECRET` secret | Only if you set `enableRecoveryWebhook: true` (default `false`) |
| Email or webhook alerts | No — silently skipped if not configured |
| R2 / D1 bindings | No — only needed if you opt into destructive purge |

### 1. Get the code

```
git clone https://github.com/JanusKlok/Cloudflare-killswitch.git
cd Cloudflare-killswitch
```

### 2. Install dependencies

```
pnpm install
```

The `.npmrc` enforces a 7-day quarantine on newly published package versions (`minimum-release-age=10080`). If install fails with a quarantine error, the package was published less than 7 days ago — wait and retry, or remove that line from `.npmrc` temporarily.

### 3. Create the KV namespace

The worker stores its state (active / killed) in a Cloudflare KV namespace. Create one:

```
pnpm exec wrangler kv namespace create KILL_SWITCH_STATE
```

The output looks like:

```
Add the following to your configuration file in your kv_namespaces array:
{ binding = "KILL_SWITCH_STATE", id = "a1b2c3d4e5f6..." }
```

Copy the `id` value — you'll need it in the next step.

### 4. Create and edit wrangler.toml

`wrangler.toml` is gitignored — it contains your personal IDs and email addresses and should never be committed. Copy the example to create your local copy:

```
# macOS / Linux:
cp wrangler.toml.example wrangler.toml

# Windows (PowerShell):
Copy-Item wrangler.toml.example wrangler.toml
```

Then open `wrangler.toml` and replace the three placeholder values:

```toml
[[kv_namespaces]]
binding = "KILL_SWITCH_STATE"
id = "paste-your-kv-namespace-id-here"   # ← from step 3

[vars]
CLOUDFLARE_ACCOUNT_ID = "your-account-id"
CLOUDFLARE_ZONE_ID    = "your-zone-id"   # ← skip if using scope = 'account' or 'none'
```

See [How to find your account ID and zone ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) in the Cloudflare docs.

### 5. Set secrets

Secrets are stored encrypted by Wrangler — they never appear in `wrangler.toml` or version control.

**Required:**

```
pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
```

Paste your Cloudflare API token when prompted. See [API token permissions](#api-token-permissions) for what scopes it needs. Create one at `dash.cloudflare.com/profile/api-tokens`.

**Optional — only needed if you set `enableRecoveryWebhook: true` in config.ts (it defaults to `false`):**

```
pnpm exec wrangler secret put RECOVERY_SECRET
```

Paste any strong random string — this is the Bearer token required to call `POST /restore`. Generate one with:

```
# Linux / macOS:
openssl rand -hex 32

# Windows (PowerShell):
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Store it in a password manager. If you leave `enableRecoveryWebhook` at its default of `false`, skip this secret entirely.

### 6. Review src/config.ts

If you ran a setup script it already created `src/config.ts` for you. Otherwise copy it from the template:

```bash
cp src/config.example.ts src/config.ts
```

`src/config.ts` is gitignored — it holds *your* thresholds and stays out of the repo, so a `git pull` never overwrites your settings and your settings never reach a pull request. Edit `src/config.example.ts` instead only if you mean to change the defaults the project ships.

Open `src/config.ts`. **The defaults work without any changes** — all thresholds are pre-set to Cloudflare's standard free-tier values and the cron runs every 5 minutes.

Only edit this file if you want to:

- Trigger earlier than the absolute limit — lower a `blockAt` value
- Enable automatic data purge — add `purgeAt` to a storage metric (see [Optional: destructive purge](#optional-destructive-purge))
- Protect all zones instead of one — change `scope` to `'account'` (requires an Enterprise plan)
- No domain on the account at all — change `scope` to `'none'` and rely on `blocking.workers` / `blocking.pages`
- Also turn off public `r2.dev` bucket URLs on a kill — set `blocking.r2` to `'all'` or a list of bucket names
- Keep the block in place until you manually restore — set `autoResetOnBillingCycle: false`
- Enable the recovery webhook — set `enableRecoveryWebhook: true` (and set `RECOVERY_SECRET` in step 5)

See the [Configuration reference](#configuration-reference) for full details on every option.

### 7. Deploy

At this point the worker is fully functional. Alerts (email or webhook) and data purge can be added later without redeploying from scratch — they are configured and enabled independently.

```
pnpm typecheck   # optional — catches type errors before deploy
pnpm test        # optional — runs the test suite against Miniflare
pnpm run deploy
```

`pnpm run deploy` first validates your configuration and only then runs `wrangler deploy`. The validator cross-checks `src/config.ts` against `wrangler.toml` and reports concrete fixes for anything that would break the deploy — or worse, make the kill switch silently do nothing when it fires (placeholder IDs, a missing zone ID with `scope: 'zone'`, `scope: 'none'` with no blocking configured, purge targets without matching bindings, and so on). It also prints the exact API-token permissions your configuration needs. You can run the check on its own at any time:

```
pnpm run validate
```

After deploying, confirm the cron trigger is registered: **Workers & Pages → cloudflare-killswitch → Settings → Trigger Events**.

The polling interval is set in `wrangler.toml` under `[triggers] crons`. The default is `*/5 * * * *` (every 5 minutes). Change it to any valid cron expression before deploying if you want a different cadence.

### 8. Verify it's working

Watch a live cron tick — with the default schedule one arrives within 5 minutes:

```
pnpm exec wrangler tail --format pretty
```

A healthy tick shows the invocation with status `Ok` and **logs nothing else**. Any `Metric fetch errors (no breach detected):` line means the Worker cannot read your usage — most often a token missing `Account Analytics: Read`.

See [Verifying it works](#verifying-it-works) for the full checklist, what each failure looks like, and how to run a controlled live fire drill.

---

## Configuration reference

All configuration lives in `src/config.ts`, your untracked copy of `src/config.example.ts`. The file is TypeScript — your editor will catch type errors.

```ts
export const CONFIG: AppConfig = {
  scope: 'zone',
  billingCycleDay: 1,
  autoResetOnBillingCycle: true,
  enableRecoveryWebhook: false,
  limits: { workers, pages, combined, kv, r2, d1 },
  purgeConfig: { r2: [], d1: [] },
  blocking: { workers: [], pages: [], r2: [] },
};
```

### scope

```ts
scope: 'zone' | 'account' | 'none'
```

Controls which WAF the block rule is deployed to.

| Value | WAF location | Plan required | What gets blocked |
|-------|-------------|--------------|-------------------|
| `'zone'` (default) | Zone WAF for `CLOUDFLARE_ZONE_ID` | Free | Traffic to that specific domain |
| `'account'` | Account WAF | Enterprise | Traffic to all domains on the account |
| `'none'` | — (no WAF rule) | Free | Nothing via WAF — only `blocking.workers` / `blocking.pages` act on kill |

Use `'zone'` unless you have an Enterprise plan and want to protect all zones simultaneously. Use `'none'` when your account has no domain/zone at all (everything runs on `workers.dev` / `pages.dev`) — a WAF rule has nothing to attach to there, so you **must** configure `blocking.workers` / `blocking.pages` or the kill switch takes no action.

### billingCycleDay

```ts
billingCycleDay: number  // 1-31, default: 1
```

The day of the UTC month your Cloudflare billing period starts. Cloudflare bills
from the day the account was created, **not** the 1st — find your renewal date
under **Manage Account → Billing** in the dashboard.

This anchors two things, so it matters even with auto-reset switched off:

- **Auto-reset timing** — when `autoResetOnBillingCycle` is on, for kills caused by a per-cycle limit
- **Per-cycle metric windows** — R2 Class A/B operations, and the KV, R2 and D1 storage ceilings

Getting it wrong mis-measures usage in both directions. With a cycle starting on
the 17th and a naive calendar-month window, a check on 5 February would count
only 1–5 February and miss everything from 17–31 January — the switch fires late,
after the overage has already been billed.

| Value | Behaviour |
|-------|-----------|
| `1` (default) | Plain calendar months — identical to the pre-`billingCycleDay` behaviour |
| `2`–`28` | Cycle opens on that day every month |
| `29`–`31` | Cycle opens on that day, falling back to the last day of shorter months (a `31` cycle opens on Feb 28, or Feb 29 in a leap year) |

Values outside 1–31, or non-integers, are rejected by `pnpm run validate` and
cause auto-reset to be skipped at runtime rather than guessed at.

> **Not sure?** Cloudflare's *invoicing* period follows your signup date, but some
> free-tier *quota* counters may still reset on the calendar month. If you cannot
> confirm which applies to your account, leave this at `1`: a window that opens
> earlier than the real quota reset over-counts, which makes the switch fire
> early rather than late.

### autoResetOnBillingCycle

```ts
autoResetOnBillingCycle: boolean  // default: true
```

When `true`, the kill switch restores itself once the quota that caused the kill
has reset, provided nothing is still over a limit:

- If every breach was a **daily** quota (Workers/Pages requests, KV reads/writes/
  deletes/lists, D1 rows), the kill ends on the first tick after 00:00 UTC.
- If any breach was **per-cycle** (R2 operations, or a KV/R2/D1 storage ceiling),
  it ends on the first tick after your billing period starts (`billingCycleDay`).
- A daily kill is upgraded to a cycle kill if a per-cycle limit is also breached
  later.

On the Free plan, exceeding a daily quota just makes requests fail (no charge),
so the daily reset mirrors Cloudflare's own behaviour.

Usage is checked on every tick, even while killed. If a limit is still exceeded
when a reset is due, the kill switch stays killed instead of restoring and
re-killing. States written by v2.0.0 reset per billing cycle, as before.

Neither reset is gated on the boundary day itself: if the Worker is down across
the boundary, it still recovers on the next tick rather than waiting another
full period.

Set to `false` if you want the block to remain indefinitely until you call
`POST /restore` manually. Useful if you want to investigate a breach before
re-enabling traffic.

### enableRecoveryWebhook

```ts
enableRecoveryWebhook: boolean  // default: false
```

When `true`:
- The worker handles `POST /restore` requests authenticated with `RECOVERY_SECRET`
- The WAF block rule expression exempts `POST /restore` so the endpoint remains reachable even while traffic is blocked. If `RECOVERY_HOSTNAME` is set, the exemption applies only to that host. If it is not set, it applies to `POST /restore` on **every host in the zone**, including your own origin app (`pnpm run validate` warns about this). Set `RECOVERY_HOSTNAME` to the hostname you call `/restore` on, and make sure it matches exactly, or the WAF blocks your restore request too. See [Environment variables and secrets](#environment-variables-and-secrets)
- With `scope: 'none'` there is no WAF rule, so the exemption does not apply

When `false`:
- `POST /restore` returns 404
- The WAF rule blocks **all** traffic without exception
- Recovery is by [auto-reset](#autoresetonbillingcycle), or by hand in the dashboard: delete the WAF rule (Security → WAF → Custom Rules), re-enable each Worker's `workers.dev` URL, roll each Pages project back, turn `r2.dev` back on, and delete the `state` key in the `KILL_SWITCH_STATE` KV namespace

**`workers_dev` in `wrangler.toml`:** `/restore` is served on the kill switch's own `workers.dev` URL, which needs `workers_dev = true`. When `enableRecoveryWebhook` is `false`, set `workers_dev = false`: the cron trigger runs without a public URL, and a public URL lets anyone send requests that count toward the 100,000/day Workers quota and so push the account towards a kill.

### limits

Each service has one or more metrics. Every metric is a `Threshold` object:

```ts
interface Threshold {
  blockAt: number;   // required — breaching this value deploys the WAF block rule
  purgeAt?: number;  // optional — breaching this value ALSO runs the purge action
                     // must be >= blockAt; leave unset to disable purge for this metric
}
```

**Workers**

```ts
workers: {
  requests: { blockAt: 100_000 }
  //                   ^^^^^^^
  //   Free tier: 100,000 invocations per day
  //   window: UTC calendar day (midnight to now)
}
```

**Pages**

```ts
pages: {
  requests: { blockAt: 100_000 }
  //   Free tier: 100,000 Pages Functions invocations per day
  //   Note: static CDN asset requests are NOT counted — only dynamic Functions calls
  //   window: UTC calendar day
}
```

**Combined (Workers + Pages Functions)**

```ts
combined: {
  requests: { blockAt: 100_000 }
  //   Pages Functions requests count toward the Workers Free quota of 100,000 per day
  //   (https://developers.cloudflare.com/pages/functions/pricing/), so this checks
  //   workers.requests + pages.requests together
  //   window: UTC calendar day
}
```

`limits.combined` is optional — leave it out and the two services are only checked separately, so 60,000 + 60,000 trips neither limit yet exceeds the shared quota (`pnpm run validate` notes when it is missing). Keep the per-service limits as well. If the Workers analytics already include Pages Functions invocations, the sum double counts: the switch may then fire early, but never late. The check is skipped, with a reported error, when either side's usage could not be read, rather than comparing a partial sum.

**KV**

```ts
kv: {
  reads:        { blockAt: 100_000 },       // read ops / day   (free tier: 100,000)
  writes:       { blockAt: 1_000 },         // write ops / day  (free tier: 1,000)
  deletes:      { blockAt: 1_000 },         // delete ops / day (free tier: 1,000)
  lists:        { blockAt: 1_000 },         // list ops / day   (free tier: 1,000)
  storageBytes: { blockAt: 1_073_741_824 }, // storage in bytes (free tier: 1 GB)
  //   reads, writes, deletes and lists: window = UTC calendar day
  //   storageBytes: highest reading per namespace in the last 48 hours, summed, not a counter
}
```

`deletes` and `lists` are required keys, metered separately from `writes`. See [Storage metrics](#storage-metrics) for how the storage figure is read.

**R2**

```ts
r2: {
  storageBytes: { blockAt: 10_737_418_240 }, // storage in bytes  (free tier: 10 GB)
  classAOps:    { blockAt: 1_000_000 },      // Class A ops / month (free tier: 1M)
  classBOps:    { blockAt: 10_000_000 },     // Class B ops / month (free tier: 10M)
  //   classAOps / classBOps: window = current billing cycle (see billingCycleDay)
  //   storageBytes:          highest reading per bucket in the last 48 hours, summed, not a counter
}
```

R2 Class A operations are the higher-priced, smaller-quota class (writes, copies, multipart steps and list operations such as `ListObjects` and `ListBuckets`). Class B covers reads and metadata lookups like `GetObject` and `HeadObject`. Deletes and `AbortMultipartUpload` are free and counted in neither class. Any operation the tool does not recognise is counted as Class A, with a warning.

**D1**

```ts
d1: {
  rowReads:     { blockAt: 5_000_000 },      // row reads / day   (free tier: 5M)
  rowWrites:    { blockAt: 100_000 },        // row writes / day  (free tier: 100,000)
  storageBytes: { blockAt: 5_368_709_120 },  // storage in bytes  (free tier: 5 GB)
  //   rowReads and rowWrites: window = UTC calendar day
  //   storageBytes:           highest reading per database in the last 48 hours, summed, not a counter
}
```

### purgeConfig

```ts
purgeConfig: {
  r2: R2PurgeTarget[],
  d1: D1PurgeTarget[],
}
```

Both arrays are **empty by default**. Purge is completely opt-in and only runs when the corresponding metric also has a `purgeAt` value that is breached. See [Optional: destructive purge](#optional-destructive-purge).

### blocking

```ts
blocking: {
  workers: 'all' | string[],  // default: []
  pages:   'all' | string[],  // default: []
  r2?:     'all' | string[],  // default: [] (absent = R2 is not touched)
}
```

Controls which additional resources are blocked when the kill switch fires. All are **empty by default** — the WAF rule handles traffic on your custom domain and no additional action is taken on `workers.dev` or `pages.dev` subdomains, or on `r2.dev` URLs, unless you configure them here.

**`blocking.workers`**

| Value | Effect |
|-------|--------|
| `[]` (default) | Workers scripts are left untouched |
| `'all'` | Every deployed Workers script **except the kill-switch itself** has its `workers.dev` subdomain and preview URLs disabled |
| `['script-a', 'script-b']` | Only the named scripts have their `workers.dev` subdomain and preview URLs disabled |

The kill reads each script's `workers.dev` state first and records only the scripts that have `workers.dev` or preview URLs switched on, with both values. Scripts that are not exposed (cron-only or service-binding-only Workers, say) are never touched, and never made public by a restore.

The kill-switch Worker is always excluded from `'all'` mode — disabling it would make the `POST /restore` endpoint unreachable via `workers.dev`.

```ts
// Disable all workers.dev subdomains on kill:
blocking: { workers: 'all', pages: [] }

// Or, target specific scripts by name:
blocking: { workers: ['my-api-worker', 'my-auth-worker'], pages: [] }
```

On restore (via `POST /restore` or auto-reset), each recorded script gets its recorded `workers.dev` and preview-URL values written back. States written by v2.0.0 (bare script names) still restore as before.

**`blocking.pages`**

Pages projects to block when the kill switch fires. Each project receives a new, empty production deployment — no files and no Worker — so every path returns Pages' own `404`. The current production deployment ID is saved first so it can be restored precisely. An empty deployment is used rather than a 503 Worker because static requests are free and unmetered, while a Worker would turn every visit into a Functions invocation counted against the 100,000/day Workers quota.

| Value | Effect |
|-------|--------|
| `[]` (default) | Pages projects are left untouched |
| `'all'` | Every Pages project on the account is blocked |
| `['project-a', 'project-b']` | Only the named projects are blocked |

```ts
blocking: { workers: [], pages: 'all' }
// or target specific projects:
blocking: { workers: [], pages: ['my-marketing-site', 'my-app-frontend'] }
```

On restore, each Pages project is rolled back to its pre-kill production deployment via the Cloudflare Pages rollback API.

**`blocking.r2`**

| Value | Effect |
|-------|--------|
| `[]` or unset (default) | R2 buckets are left untouched |
| `'all'` | The public `r2.dev` URL of every bucket on the account is turned off (all jurisdictions) |
| `['bucket-a', 'bucket-b']` | Only the named buckets have their `r2.dev` URL turned off |

```ts
blocking: { workers: [], pages: [], r2: 'all' }
```

On a breach the kill switch turns off each bucket's public `r2.dev` URL, and on restore turns it back on only for buckets whose URL was on before the kill, so private buckets are never made public. A bucket whose state could not be read is still blocked but left off at restore (reported in the alert, so you can re-enable it by hand). Buckets served through a connected custom domain, and S3-API access with R2 API tokens, are **not** blocked. Turning the URL off likely also stops the Class B read operations it serves, but Cloudflare's docs do not confirm that `r2.dev` requests are billed as Class B.

**API token permissions required:** If `blocking.workers`, `blocking.pages` or `blocking.r2` is non-empty, your API token needs additional permissions beyond the WAF rule. See [API token permissions](#api-token-permissions).

### Environment variables and secrets

Variables go in `[vars]` in `wrangler.toml`; secrets are set with `pnpm exec wrangler secret put <NAME>`. The setup scripts prompt for the account and zone IDs, the API token, the recovery secret and the email addresses. `WORKER_SELF_NAME` keeps the example default, and `RECOVERY_HOSTNAME` and `ALERT_WEBHOOK_URL` are left to you.

| Name | Kind | Needed when | What it does |
|------|------|-------------|--------------|
| `CLOUDFLARE_API_TOKEN` | secret | always | API token, see [API token permissions](#api-token-permissions) |
| `CLOUDFLARE_ACCOUNT_ID` | var | always | Account for every metric query and blocking action |
| `CLOUDFLARE_ZONE_ID` | var | `scope: 'zone'` | Zone that receives the WAF rule |
| `WORKER_SELF_NAME` | var | always (matters most with `blocking.workers: 'all'`) | Must equal the `name` at the top of `wrangler.toml` (default `cloudflare-killswitch`). With `'all'`, the Worker uses it to exclude itself. A mismatch makes `pnpm run validate` report an error under `'all'` (a warning otherwise), because the kill switch would disable its own `workers.dev` URL and `/restore` would become unreachable |
| `RECOVERY_SECRET` | secret | `enableRecoveryWebhook: true` | Bearer token for `POST /restore`. If it is unset, `/restore` answers `500` rather than accepting requests |
| `RECOVERY_HOSTNAME` | var, optional | `enableRecoveryWebhook: true` and a WAF scope | Hostname `/restore` is served on, for example `cloudflare-killswitch.<subdomain>.workers.dev`. The WAF rule then exempts `POST /restore` only on that host. Without it, the exemption covers `POST /restore` on every host in the zone, and the validator warns |
| `ALERT_WEBHOOK_URL` | secret, optional | webhook alerts | `https` URL for ntfy, Discord, Slack or any other service, see [Webhook setup](#webhook-setup) |
| `EMAIL_FROM`, `EMAIL_TO` | var, optional | email alerts | Sender and recipient, together with the `[[send_email]]` block, see [Email setup](#email-setup) |

`RECOVERY_HOSTNAME` is read when the WAF rule is deployed, so it only affects kills that happen after you set it and redeploy.

---

## How this compares with Cloudflare Spend Management

Cloudflare's [Spend Management](https://blog.cloudflare.com/spend-management/) lets pay-as-you-go customers set spend caps. This kill switch instead watches free-tier quotas and request counts and blocks traffic. Check Cloudflare's current docs for which products a cap covers and what it pauses: a cap that pauses Workers would also pause the Cron Trigger this kill switch runs on.

---

## Metrics and default limits

| Service | Metric | Billing window | Free-tier limit |
|---------|--------|---------------|-----------------|
| Workers | requests | Daily (UTC midnight → now) | 100,000 / day |
| Pages | invocations (Functions only) | Daily | 100,000 / day |
| Workers + Pages | requests, summed (`limits.combined`) | Daily | 100,000 / day (shared Workers Free quota) |
| KV | reads | Daily | 100,000 / day |
| KV | writes | Daily | 1,000 / day |
| KV | deletes | Daily | 1,000 / day |
| KV | lists | Daily | 1,000 / day |
| KV | storage | Highest reading per namespace in the last 48 h, summed | 1 GB |
| R2 | storage | Highest reading per bucket in the last 48 h, summed | 10 GB |
| R2 | Class A operations | Monthly | 1,000,000 |
| R2 | Class B operations | Monthly | 10,000,000 |
| D1 | row reads | Daily | 5,000,000 / day |
| D1 | row writes | Daily | 100,000 / day |
| D1 | storage | Highest reading per database in the last 48 h, summed | 5 GB |

**Window alignment:** Daily metrics query from UTC midnight of the current day to now. Per-cycle metrics (R2 Class A/B operations) query from UTC midnight of the day the current billing period opened (see [`billingCycleDay`](#billingcycleday)) to now — with `billingCycleDay: 1` that is the 1st of the calendar month. Storage metrics are different, see [Storage metrics](#storage-metrics).

**One request per tick:** Each tick reads all usage metrics with a single GraphQL request (it used to take 8). If Cloudflare reports an error for one dataset, only that service is marked failed; the others are still evaluated.

**Thresholds and timing:** The default thresholds equal Cloudflare's limits. With 5-minute polling and roughly 1–2 minutes of analytics lag, the switch fires shortly after a limit is crossed, not before it.

**Analytics lag:** Cloudflare's GraphQL Analytics API has a pipeline delay of roughly 1–2 minutes. Usage values seen by the worker may be slightly behind real-time.

**D1 storage aggregation:** The D1 storage metric is the total across all D1 databases on the account, because Cloudflare bills it as a single account-level quota.

### Storage metrics

Storage is a gauge, not a running total. For each KV namespace, R2 bucket and D1 database the worker takes the **highest reading in the last 48 hours**, sums those maxima across all of them, and compares the total to the ceiling. A peak freed weeks ago does not trigger a block, but storage you freed recently can still count for up to 48 hours. Storage samples are tagged with the `cycle` window in reports, so a storage breach resets with the billing period, not at 00:00 UTC.

---

## Optional: alerts (email and webhook)

When the kill switch fires, it can send you a full report listing every breached metric, the WAF rule IDs, and any purge results. Alerts can go to email, to a webhook, or to both. Email requires **Cloudflare Email Routing** to be configured on your account; a webhook needs no domain.

Alerts are sent on:

- the kill itself
- later changes while killed (a newly blocked target, a WAF rule that finally deployed, a purge, a kill upgraded to a cycle kill)
- an auto-reset, whether it succeeded or only partly
- `POST /restore`
- failing usage checks — at most once per UTC day

If no channel is configured, none of this is sent: the kill switch still fires and the events only show up in the logs.

### Email setup

**1. Enable Email Routing**

In the Cloudflare dashboard, go to your domain → Email → Email Routing. Enable it and verify at least one destination address.

**2. Edit wrangler.toml**

Uncomment the `[[send_email]]` block and add the email vars:

```toml
[[send_email]]
name = "SEND_EMAIL"
destination_address = "you@example.com"   # must be verified in Email Routing

# Add these lines in the existing [vars] section:
EMAIL_FROM = "killswitch@yourdomain.com"  # verified sender address for your domain
EMAIL_TO   = "you@example.com"            # must match destination_address above
```

`EMAIL_FROM` must be an address that Cloudflare Email Routing will accept as a sender for your domain. Usually `anything@yourdomain.com` works once Email Routing is enabled on that domain.

**3. Redeploy**

```
pnpm run deploy
```

If any of `SEND_EMAIL`, `EMAIL_FROM`, or `EMAIL_TO` are absent, email is silently skipped. The kill switch still fires and traffic is still blocked — you just won't get an email.

### Webhook setup

Alerts can go to a webhook as well as email, no domain needed. Set the URL as a secret — it is a credential, since anyone holding it can post to your channel:

```
pnpm exec wrangler secret put ALERT_WEBHOOK_URL
```

ntfy.sh topic URLs, Discord webhook URLs and Slack incoming-webhook URLs work. The payload format is picked from the host; anything else gets ntfy-style plain text with a `Title` header. The URL must be `https`.

| Service | Example URL | Payload |
|---------|-------------|---------|
| ntfy | `https://ntfy.sh/<your-long-random-topic>` | Plain text body, subject as the `Title` header |
| Discord | `https://discord.com/api/webhooks/<id>/<token>` | JSON, truncated to Discord's 2,000-character limit |
| Slack | `https://hooks.slack.com/services/T000/B000/XXXX` | JSON |

Use a long random ntfy topic: topics are public, so anyone who guesses the name can read your alerts.

Email and webhook are independent: if one channel fails, the other is still tried, and a failed alert never aborts a tick. The webhook is a secret, so `pnpm run validate` cannot see it — it warns when no email is configured, as a reminder to set the webhook, and you can ignore that warning if you have.

### Logs

`wrangler.toml.example` ships with `[observability] enabled = true`, which keeps the Worker's logs (including `console.error` output from failed ticks) in Workers Logs, readable in the dashboard after the fact. On the Free plan that is 200,000 logs per day with 3 days of retention. `pnpm run validate` notes when it is switched off.

### What the alert looks like

```
Subject: [Kill Switch] Traffic blocked — limits breached

Kill Switch triggered. WAF block rule deployed.

Breaches detected:
  - workers.requests (per day): 127,543 observed, limit 100,000 [BLOCK]
  - r2.storageBytes (per billing cycle): 10.84 GiB observed, limit 10.00 GiB [PURGE]

WAF rule ID : abc123def456
WAF ruleset : ghi789jkl012
Scope       : zone

R2 purge results:
  MY_UPLOADS_BUCKET: deleted 1,204 object(s)

To restore: POST /restore with Authorization: Bearer <RECOVERY_SECRET>
```

---

## Optional: Workers, Pages and R2 blocking

By default, the kill switch only deploys a WAF Custom Rule. Traffic on your custom Cloudflare-proxied domains is immediately blocked, but `workers.dev` and `pages.dev` subdomains, and public `r2.dev` bucket URLs, are **not** affected by WAF rules.

> **The reverse gap matters too.** `blocking.workers` disables a script's
> `workers.dev` subdomain and preview URLs and nothing else — a Worker served on a **custom
> domain or route keeps serving**. Those are covered by the WAF rule instead, so
> the two mechanisms are complementary rather than redundant:
>
> | | `workers.dev` / `pages.dev` | Custom proxied domain |
> |---|---|---|
> | WAF rule (`scope: 'zone'` / `'account'`) | not covered | **blocked** |
> | `blocking.workers` / `blocking.pages` | **blocked** | not covered |
>
> With `scope: 'none'` there is no WAF rule at all, so a Worker on a custom
> domain is not blocked by anything. If you have a domain, use `scope: 'zone'`.

Configure `blocking` in `src/config.ts` to also shut down those surfaces.

### Block workers.dev subdomains

```ts
blocking: {
  workers: 'all',   // or an explicit list: ['my-api', 'my-auth-worker']
  pages: [],
},
```

- `'all'` discovers all deployed Workers scripts via the Cloudflare API and checks each one, **excluding the kill-switch itself** (so `POST /restore` remains reachable).
- An explicit `string[]` checks only the named scripts.

For each script the kill first reads its `workers.dev` state, and records only the scripts that have `workers.dev` or preview URLs on, with both values. It then turns off both `enabled` and `previews_enabled`. On restore, the recorded values are written back, so cron-only and service-binding-only Workers are never made public. Workers subdomain state is saved to KV; states written by v2.0.0 (bare script names) still restore as before.

**API token requirement:** Add `Account → Workers Scripts → Edit` to your token.

### Block pages.dev subdomains

```ts
blocking: {
  workers: [],
  pages: ['my-marketing-site', 'my-app-frontend'],
},
```

When the kill switch fires:
1. The current production deployment ID and production branch are fetched from the Cloudflare Pages API and saved to KV.
2. A new, empty deployment (no files, no Worker) is pushed to the production branch, so the site returns `404` on every path. Visitors and search engines see a 404 rather than a 503 — the price of keeping blocked traffic free.

On restore, each project is rolled back to its saved production deployment via the Pages rollback API. The empty deployment stays in the project's history. Both steps were verified against the live API (direct-upload project, 2026-11-17).

**API token requirement:** Add `Account → Cloudflare Pages → Edit` to your token.

### Block r2.dev public URLs

```ts
blocking: {
  workers: [],
  pages: [],
  r2: 'all',   // or an explicit list: ['my-public-assets']
},
```

What gets turned off, what is restored and what is not covered is described under [`blocking.r2`](#blocking) in the configuration reference. `'all'` covers buckets in every jurisdiction.

**API token requirement:** Add `Account → Workers R2 Storage → Edit` to your token.

### Combining them

```ts
blocking: {
  workers: 'all',
  pages: ['my-marketing-site'],
  r2: 'all',
},
```

Workers, Pages and R2 blocking run in parallel and are all best-effort — a failure in one does not prevent the others from executing. The WAF rule always fires first regardless.

### While killed

The block is not a one-shot. Every tick while killed:

- Workers, Pages projects and R2 buckets created since the kill are blocked (with `'all'`).
- Blocks that failed are retried.
- A WAF rule that never deployed is retried — an existing kill-switch rule is adopted rather than stacked on top.
- A purge runs, at most once per service, if `purgeAt` is reached after the kill.

KV is written only when something changed, and an alert is sent only when something new happened.

**Known gap:** a recorded Worker that is re-enabled by a redeploy (for example `wrangler deploy` with `workers_dev = true`), or a recorded Pages project that is redeployed during the kill, is **not** re-blocked.

### Free-plan subrequest budget

On the Workers Free plan each invocation is capped at 50 subrequests, and every Cloudflare API call, KV operation, and R2 list/delete counts against it. Roughly what a tick costs:

| Situation | Subrequests |
|-----------|-------------|
| Quiet tick | 1 GraphQL request |
| Each tick while killed | plus list calls for the blocking set to `'all'`: one Workers scripts list, one Pages projects list, and up to 5 R2 bucket lists (one per jurisdiction) |
| The first kill | plus, per Worker, one GET and (if exposed) one POST; per Pages project, one GET and one deploy; per R2 bucket, one GET and (if public) one PUT; plus the WAF calls |
| Restore | one call per recorded item |

With `'all'` blocking, Workers that are not exposed on `workers.dev` and R2 buckets whose `r2.dev` URL is off are never recorded, so they are re-read (one GET each) on every killed tick. That cost grows with the number of such targets on the account.

A purge adds its own R2/D1 calls on top. Roughly 20 targets in total (Workers + Pages projects + R2 buckets) is a practical ceiling on the Free plan. Beyond that some blocks may fail (failures are logged, and retried on the next tick), so list the targets that matter explicitly, or run the kill switch on a paid plan (10,000 subrequests).

---

## Optional: destructive purge

In addition to blocking traffic, the worker can permanently delete data from R2 buckets and D1 databases when a metric crosses a second, higher `purgeAt` threshold. Purges are scoped to the breaching service: only an R2 breach runs the R2 purge targets, and only a D1 breach runs the D1 purge targets — a breach on Workers, Pages, or KV never deletes data.

**This action is irreversible.** Deleted data cannot be recovered. Purge is disabled by default and requires explicit configuration for each metric and each resource you want to purge.

The two thresholds are independent:
- `blockAt` — traffic is blocked. Data is untouched.
- `purgeAt` — traffic is blocked **and** configured purge actions run.

A metric without `purgeAt` can never trigger a purge regardless of how high the value climbs.

### R2 purge

**Step 1 — Add purgeAt to the threshold**

In `src/config.ts`, add `purgeAt` to the R2 metric you want to trigger purge. It must be greater than `blockAt`:

```ts
r2: {
  storageBytes: {
    blockAt: 10_737_418_240,   // 10 GB — block traffic at this point
    purgeAt: 11_000_000_000,   // 11 GB — also purge data at this point
  },
  classAOps: { blockAt: 1_000_000 },
  classBOps: { blockAt: 10_000_000 },
},
```

**Step 2 — Configure which bucket(s) to purge**

Add entries to `purgeConfig.r2`:

```ts
purgeConfig: {
  r2: [
    {
      bindingName: 'MY_UPLOADS_BUCKET', // must exactly match the binding name in wrangler.toml
      prefixes: ['uploads/temp/'],      // limit deletion to this prefix; [] means the entire bucket
      deleteOrder: 'newest',            // 'newest' deletes most recently uploaded objects first
                                        // 'oldest' deletes oldest objects first
    },
    {
      bindingName: 'ANOTHER_BUCKET',
      prefixes: [],                     // purge the entire bucket
      deleteOrder: 'oldest',
    },
  ],
  d1: [],
},
```

You can configure multiple buckets. Each is purged independently — a failure in one does not stop the others.

`prefixes` lets you limit the purge to a path prefix within the bucket. An empty array means the entire bucket is purged. You can combine multiple prefixes:

```ts
prefixes: ['cache/', 'tmp/', 'scratch/'],
```

**Step 3 — Add the R2 binding to wrangler.toml**

Uncomment and fill in the `[[r2_buckets]]` block for each bucket:

```toml
[[r2_buckets]]
binding     = "MY_UPLOADS_BUCKET"     # must exactly match bindingName in config.ts
bucket_name = "your-actual-r2-bucket-name"

[[r2_buckets]]
binding     = "ANOTHER_BUCKET"
bucket_name = "another-r2-bucket"
```

**Step 4 — Redeploy**

```
pnpm run deploy
```

### D1 purge

**Step 1 — Add purgeAt to the threshold**

```ts
d1: {
  rowReads:  { blockAt: 5_000_000 },
  rowWrites: { blockAt: 100_000 },
  storageBytes: {
    blockAt: 5_368_709_120,   // 5 GB — block traffic
    purgeAt: 5_500_000_000,   // 5.5 GB — also purge tables
  },
},
```

**Step 2 — Configure which database(s) and tables to purge**

```ts
purgeConfig: {
  r2: [],
  d1: [
    {
      bindingName: 'MY_APP_DB',    // must exactly match the binding name in wrangler.toml
      tables: [
        { name: 'events',       action: 'DELETE_ALL' }, // empties the table (schema preserved)
        { name: 'request_log',  action: 'DELETE_ALL' }, // empties the table
        { name: 'cache',        action: 'DROP' },       // drops the table entirely (schema lost)
      ],
    },
  ],
},
```

Two actions are available per table:

| Action | SQL executed | Effect |
|--------|-------------|--------|
| `DELETE_ALL` | `DELETE FROM \`table\`` | Removes all rows. Table structure and indexes are preserved. |
| `DROP` | `DROP TABLE IF EXISTS \`table\`` | Removes the table entirely including its schema. |

Tables are processed in the order listed. If one table fails, the rest still run. Errors are reported in the alert.

**Step 3 — Add the D1 binding to wrangler.toml**

```toml
[[d1_databases]]
binding     = "MY_APP_DB"                   # must exactly match bindingName in config.ts
database_id = "your-d1-database-uuid"
```

Find the database UUID in the Cloudflare dashboard under Workers & Pages → D1.

**Step 4 — Redeploy**

```
pnpm run deploy
```

---

## Recovery

There are two ways to lift a kill-switch block:

### Auto-reset (when the quota resets)

With `autoResetOnBillingCycle: true` (the default), the worker restores itself on the first cron tick after the quota that caused the kill has reset, as long as nothing is still over a limit. It undoes the same things as `POST /restore` (see [How it works](#how-it-works)) and then resumes normal monitoring. [`autoResetOnBillingCycle`](#autoresetonbillingcycle) explains which limits reset when, and what happens if a limit is still exceeded.

### Manual restore via webhook

Call `POST /restore` from anywhere with your `RECOVERY_SECRET`:

```
POST https://cloudflare-killswitch.<your-subdomain>.workers.dev/restore
Authorization: Bearer YOUR_RECOVERY_SECRET
```

With curl (Linux / macOS):

```
curl -s -X POST https://cloudflare-killswitch.your-subdomain.workers.dev/restore -H "Authorization: Bearer YOUR_RECOVERY_SECRET" | jq
```

With PowerShell (Windows PowerShell 5.1 and PowerShell 7). In 5.1 `curl` is an alias for `Invoke-WebRequest` and does not accept these flags, so use `Invoke-RestMethod`:

```
Invoke-RestMethod -Method Post -Uri https://cloudflare-killswitch.your-subdomain.workers.dev/restore -Headers @{ Authorization = "Bearer YOUR_RECOVERY_SECRET" }
```

`Invoke-RestMethod` throws on a non-2xx status (403, 502 and so on) instead of printing the JSON body. The status code in the error still tells you which case below you hit.

**Success (200):**

```json
{ "restored": true, "previousReason": "2 block breach(es)" }
```

**Wrong or missing token (403):**

```json
{ "error": "Unauthorized" }
```

**Partial failure (502):**

```json
{ "restored": false, "previousReason": "2 block breach(es)", "errors": ["workers not re-enabled: my-api"] }
```

Both the `200` and the `502` can carry a `notes` array for things that are not failures, such as R2 buckets deliberately left off because their state before the kill was unknown.

**Recovery secret not set (500):**

```json
{ "error": "Recovery secret not configured" }
```

This is returned when `enableRecoveryWebhook` is `true` but the `RECOVERY_SECRET` secret was never set. Run `pnpm exec wrangler secret put RECOVERY_SECRET`. The `500` is checked before the rate limit and the token.

**Rate limited (429):** `{ "error": "Too Many Requests" }` with a `Retry-After: 60` header.

#### Partial restore

Only the failed items remain recorded in the killed state, marked `restorePending`. You can call `POST /restore` again to retry just those, but you do not have to: every 5-minute cron tick also retries a partial restore automatically, even with `autoResetOnBillingCycle: false`, unless a limit is breached at that moment (a live breach re-arms the kill and blocks everything again).

The call is idempotent — if the worker is already `active`, it returns `200` with `restored: true` anyway. Requests are rate-limited to 10 per 60 seconds per client IP (`429` with a `Retry-After` header beyond that); every request counts, not just failed ones.

The limit uses the Workers Rate Limiting binding `RESTORE_RATE_LIMITER`, declared in the `[[ratelimits]]` block of `wrangler.toml.example` (needs wrangler 4.36+; counts are per Cloudflare location, so it is a soft cap). Without the binding an in-memory per-isolate limiter is used instead, and `pnpm run validate` warns. Rate limiting never writes to KV, so rotating IPs cannot burn the account's KV write quota. The binding works on the Workers Free plan (verified 2026-11-17); in that test, being eventually consistent, it started answering `429` after about 20 requests in a minute rather than exactly 10.

With `enableRecoveryWebhook: true` and a WAF scope (`'zone'` or `'account'`), the WAF block rule exempts `POST /restore`, so it remains reachable even while all other traffic is blocked. The exemption is limited to the host in `RECOVERY_HOSTNAME` when that is set, and otherwise covers `POST /restore` on every host in the zone. See [Environment variables and secrets](#environment-variables-and-secrets).

**Finding your worker URL:** After `wrangler deploy`, the URL is printed in the output. It follows the pattern `https://cloudflare-killswitch.<your-subdomain>.workers.dev`. You can also find it in the dashboard under Workers & Pages → cloudflare-killswitch → Settings → Domains & Routes.

If you've lost your `RECOVERY_SECRET`, set a new one and redeploy:

```
pnpm exec wrangler secret put RECOVERY_SECRET
pnpm run deploy
```

---

## Verifying it works

A deployed kill switch that cannot read your usage looks exactly like one that has nothing to report: the cron runs, nothing is logged, and no traffic is blocked. Work through these four checks in order — each one rules out a different silent failure.

### 1. The configuration is coherent

```
pnpm run validate
```

This cross-checks `src/config.ts` against `wrangler.toml` before anything reaches Cloudflare. It ends in `Config check passed.` (or `Config check passed with N warning(s).` when there are warnings; errors end in `Config check failed` and a non-zero exit) and prints the exact API-token permissions your configuration needs. It cannot inspect the token itself, so treat that list as a to-do rather than a result.

### 2. The Worker and its cron trigger are actually deployed

```
pnpm exec wrangler deployments list
```

There is no `wrangler` command that lists cron triggers, so confirm the schedule one of two ways: the `wrangler deploy` output ends with a `schedule:` line for every registered trigger, or check **Workers & Pages → your Worker → Settings → Trigger Events** in the dashboard. A Worker with no cron trigger never evaluates anything, and nothing about it looks broken.

### 3. A cron tick runs cleanly — the check that matters most

```
pnpm exec wrangler tail --format pretty
```

Leave it running until a tick arrives (within 5 minutes on the default `*/5 * * * *`). This is a real capture from a healthy install:

```
Successfully created tail, expires at 2026-09-08T15:02:15Z
Connected to cloudflare-killswitch, waiting for logs...
"*/5 * * * *" @ 8.9.2026, 11.05.03 - Ok
"*/5 * * * *" @ 8.9.2026, 11.10.03 - Ok
```

That is the whole output — two ticks, five minutes apart, `Ok`, and **not one log line between them**. That silence is the result you want, and it is a stronger signal than it looks: the monitoring routine returns early without logging only when every metric module resolved *and* nothing breached. There is no code path where a failed usage query produces a silent tick, so a clean tick proves the API token's `Account Analytics: Read` is working across all five services.

(Wrangler prints timestamps in your system locale — `8.9.2026` is 8 September here.)

Wait for a second tick before concluding anything. One tick tells you the Worker ran; two on schedule tell you the cron trigger is genuinely registered rather than a one-off.

Read a non-silent tail as follows:

| What you see | What it means |
|---|---|
| A `scheduled` invocation, status `Ok`, no log lines | **Healthy.** Every metric was read and nothing is near its limit. Silence is the success signal — the Worker only logs problems. |
| `Metric fetch errors (no breach detected):` | The Worker cannot read your usage, so **it will never fire**. Almost always an API-token problem — see below. |
| `scheduled tick failed:` | An unexpected error before monitoring began, e.g. KV unreachable. The message names the cause. |
| No invocation at all within 5 minutes | The cron trigger is not registered — go back to check 2. |
| `waf deploy error:` / `block-workers error:` / `block-pages error:` / `block-r2 error:` | A breach **was** detected and the Worker tried to act, but an action failed. Check that permission on the token. While killed, failed blocks are retried every tick. |
| `auto-reset is due but usage is still over a limit — staying killed` | The quota that caused the kill has reset, but a limit is still exceeded, so the block stays in place. |

If you see `Metric fetch errors`, the message carries the GraphQL error. A `403` means the token is missing `Account Analytics: Read` at the **account** level — the single most common misconfiguration, because it is the one permission the Worker needs no matter how everything else is set. See [API token permissions](#api-token-permissions).

### 4. The stored state is what you expect

```
pnpm exec wrangler kv key get state --binding KILL_SWITCH_STATE --remote
```

The `--binding` form reads the namespace id out of your `wrangler.toml`, so there is nothing to paste.

**A `404: Not Found` here is normal on a healthy install.** The `state` key is only written when the Worker kills or restores; until then there is nothing to read and the Worker treats the absent key as `active`. After a kill you get the full record instead, in the format shown under [How it works](#how-it-works).

`reason` is deliberately just a count — the per-metric breakdown (`workers.requests (per day): 104,213 observed, limit 100,000 [BLOCK]`) goes to the alert and the logs, so enable [email or webhook alerts](#optional-alerts-email-and-webhook) if you want to know *which* limit went.

`killedAt` and `resetWindow` decide when auto-reset is due, and `wafRuleId` / `disabledWorkerScripts` / `blockedPagesProjects` / `blockedR2Buckets` are the undo list — recovery replays exactly what is recorded here, which is why the Worker writes its intent *before* it mutates anything.

Note that an absent key proves only that nothing has fired. It does **not** prove the Worker can read your usage — that is what check 3 is for.

### Optional: a controlled live fire drill

The checks above confirm the monitoring path. Only a real breach confirms the *blocking* path, and you can force one safely on a test account by lowering a threshold below your current usage.

> **Read this first.** With `blocking.workers: 'all'` the drill disables the `workers.dev` subdomain of every Worker on the account except the kill switch, and with `blocking.pages: 'all'` it replaces every Pages production deployment with an empty one (404). Do not drill on an account serving anything you care about. If `purgeAt` is set on any metric, **remove it before drilling** — purge deletes R2 objects and D1 rows, and no restore path brings those back.

1. **Give yourself a way back in first.** Set `enableRecoveryWebhook: true` in `src/config.ts`, run `pnpm exec wrangler secret put RECOVERY_SECRET` (any long random string), and deploy. Without this, undoing the drill means re-enabling every Worker and Pages project by hand in the dashboard.

2. **Lower one threshold** below current usage — `limits.workers.requests.blockAt: 1` is the easiest — and deploy.

3. **Watch it fire** in `wrangler tail`. Within one tick you should see the breach reason, then the actions. Confirm the effect independently: your other `workers.dev` URLs should stop serving, and with `scope: 'zone'` a rule named *Kill Switch — automated traffic block* appears under your zone's WAF Custom Rules.

4. **Restore**:

   ```
   curl -X POST https://your-worker.your-subdomain.workers.dev/restore -H "Authorization: Bearer YOUR_RECOVERY_SECRET"
   ```

   In PowerShell:

   ```
   Invoke-RestMethod -Method Post -Uri https://your-worker.your-subdomain.workers.dev/restore -Headers @{ Authorization = "Bearer YOUR_RECOVERY_SECRET" }
   ```

   A `200` with `{"restored":true,...}` means everything in the undo list was reversed. A `502` lists what could not be reversed — fix those by hand before trusting the install.

5. **Put the threshold back** and deploy. Re-check `pnpm run validate`, and turn the recovery webhook back off if you do not want it permanently.

The drill is worth doing once on a throwaway account, because it is the only thing that proves the token's *write* permissions. Checks 1–4 exercise reads only.

---

## API token permissions

Create a **Custom Token** at `dash.cloudflare.com/profile/api-tokens`. Click "Create Token" → "Get started" (custom token).

**Always required, whatever your configuration:**

| Permission group | Permission | Level |
|------------------|-----------|-------|
| Account → Account Analytics | Read | Account |

Every metric this Worker reads comes from the account-scoped GraphQL Analytics API. Without this permission each query returns 403, no breach is ever detected, and the kill switch sits there looking deployed while doing nothing — the quietest possible failure. Add the permissions below on top of it.

**For `scope: 'zone'` (default, WAF only):**

| Permission group | Permission | Level |
|------------------|-----------|-------|
| Zone → WAF | Edit | Zone (select your specific zone) |

**For `scope: 'account'` (WAF only):**

| Permission group | Permission | Level |
|------------------|-----------|-------|
| Account → Account WAF | Edit | Account |

**For `scope: 'none'`:** no WAF permission needed — only the `blocking.*` permissions below apply.

**If `blocking.workers` is non-empty, add:**

| Permission group | Permission | Level |
|------------------|-----------|-------|
| Account → Workers Scripts | Edit | Account |

**If `blocking.pages` is non-empty, add:**

| Permission group | Permission | Level |
|------------------|-----------|-------|
| Account → Cloudflare Pages | Edit | Account |

**If `blocking.r2` is non-empty, add:**

| Permission group | Permission | Level |
|------------------|-----------|-------|
| Account → Workers R2 Storage | Edit | Account |

Account membership alone does **not** grant GraphQL Analytics access to an API token — `Account Analytics: Read` above is required, and account-scoped datasets need it at the account level rather than scoped to a single zone.

Scope the token to specific zones or accounts where possible to follow the principle of least privilege. After creating the token, copy it immediately — Cloudflare only shows it once.

---

## Upgrading from 2.0.0

`src/config.ts` and `wrangler.toml` are untracked, so `git pull` never changes them. Compare them against `src/config.example.ts` and `wrangler.toml.example` and apply the points below, then run `pnpm run validate` and `pnpm run deploy`.

**Breaking**

- `limits.kv.deletes` and `limits.kv.lists` are now required (`{ blockAt: 1_000 }` each on the Free plan). They used to be counted inside `writes`. Add both keys to your `src/config.ts`.
- `blocking.pagesCompatibilityDate` is ignored. Blocked Pages projects now get an empty production deployment that returns `404` on every path, instead of a 503 Worker.

**New and optional**

- `limits.combined.requests`: checks Workers and Pages Functions together against the shared 100,000/day quota. See [limits](#limits).
- `blocking.r2`: turns off `r2.dev` URLs on a kill. See [`blocking`](#blocking). It needs the `Workers R2 Storage: Edit` token permission.
- `ALERT_WEBHOOK_URL` secret: webhook alerts. See [Webhook setup](#webhook-setup).
- `[[ratelimits]]` block in `wrangler.toml` (binding `RESTORE_RATE_LIMITER`): rate limit for `/restore` that does not write to KV. Copy it from `wrangler.toml.example`.
- `[observability]` block in `wrangler.toml`: keeps Worker logs. Copy it from `wrangler.toml.example`.
- `RECOVERY_HOSTNAME` var: limits the WAF `/restore` exemption to one host. See [Environment variables and secrets](#environment-variables-and-secrets).

Kill states written by 2.0.0 still restore. They reset per billing cycle, never purge on a later tick, and a partial restore from 2.0.0 is recognised and finished by later ticks.

---

## Local development and testing

### Running tests

The test suite runs against Miniflare (Cloudflare's local Workers runtime) — no real account or API token needed. In a fresh clone, create your config first (`src/config.ts` is gitignored, so it is not there yet):

```
cp src/config.example.ts src/config.ts
pnpm test
```

To watch for changes:

```
pnpm test:watch
```

### Type checking

```
pnpm typecheck
```

### Running locally with wrangler dev

Create a `.dev.vars` file for local secrets (this file is gitignored — never commit it):

```ini
CLOUDFLARE_API_TOKEN=your-real-or-test-token
RECOVERY_SECRET=any-local-secret
```

Then start the local dev server:

```
pnpm dev
```

Trigger the cron handler manually (use your configured cron expression, URL-encoded):

```
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

In PowerShell:

```
Invoke-RestMethod -Uri "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"
```

Test the restore endpoint (this needs `enableRecoveryWebhook: true` in your `src/config.ts`, otherwise it returns 404):

```
curl -X POST http://localhost:8787/restore -H "Authorization: Bearer any-local-secret"
```

In PowerShell:

```
Invoke-RestMethod -Method Post -Uri http://localhost:8787/restore -Headers @{ Authorization = "Bearer any-local-secret" }
```

The `wrangler dev` server uses the KV namespace from `wrangler.toml` with a local persistent store under `.wrangler/state/`. Restart `wrangler dev` to clear it, or manually delete the `.wrangler/` directory.

---

## Extending: adding a new service

The worker is built around a `ServiceModule` interface. Adding a 6th monitored service involves three files and one registration line — the orchestrator in `src/scheduled.ts` never needs to change.

**`src/types.ts`** — add the limit shape:

```ts
export interface MyServiceLimits {
  requests: Threshold;
}

// and inside AppConfig.limits:
myservice: MyServiceLimits;
```

**`src/config.example.ts`** — add defaults (`src/config.ts` is your untracked copy; add the same keys there to try it locally):

```ts
limits: {
  // ... existing services ...
  myservice: {
    requests: { blockAt: 50_000 },
  },
},
```

**`src/metrics/myservice.ts`** — implement the module. A module does not make its own request: it describes the dataset it needs (`query`), and the collector merges every module's selection into the single per-tick GraphQL request (see [Metrics and default limits](#metrics-and-default-limits)):

```ts
import type { AccountData, AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import { utcDayStart, utcNow } from '../graphql/queries.js';
import { evaluateSample } from './evaluate.js';

interface MyServiceAccount {
  myServiceDataset?: { sum: { requests: number } }[];
}

export const myServiceModule: ServiceModule = {
  name: 'myservice',

  query() {
    return {
      // Response keys this selection adds — a GraphQL error whose path runs
      // through one of them marks only this module as failed.
      keys: ['myServiceDataset'],
      selection: `myServiceDataset(filter: { datetime_geq: $myserviceStart, datetime_leq: $myserviceEnd }) {
        sum { requests }
      }`,
      // Variable names must be unique across modules: prefix them with the module name.
      variables: {
        myserviceStart: { type: 'String!', value: utcDayStart() },
        myserviceEnd: { type: 'String!', value: utcNow() },
      },
    };
  },

  parse(account: AccountData): MetricSample[] {
    const rows = (account as MyServiceAccount).myServiceDataset ?? [];
    const requests = rows.reduce((sum, r) => sum + r.sum.requests, 0);
    return [{ metric: 'requests', value: requests, window: 'day' }];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    return samples.flatMap((s) =>
      evaluateSample('myservice', s, cfg.limits.myservice[s.metric as keyof typeof cfg.limits.myservice]),
    );
  },
};
```

**`src/metrics/index.ts`** — register it:

```ts
import { myServiceModule } from './myservice.js';

export const MODULES: ServiceModule[] = [
  workersModule, pagesModule, kvModule, r2Module, d1Module,
  myServiceModule,  // ← add here
];
```

Add a test file at `test/myservice.test.ts` following the patterns in the existing test files, and you're done.

---

## Troubleshooting

**The cron fired but nothing happened**

Check the logs with `pnpm exec wrangler tail`. Common causes:
- Usage is genuinely below all thresholds — normal behaviour
- Analytics data lag (1–2 minutes) means the reading is briefly stale — wait for the next tick
- A module threw an error fetching data — the error is logged but does not trigger a false kill

**The kill switch fired but traffic is still coming through**

Verify `CLOUDFLARE_ZONE_ID` in `wrangler.toml` matches the zone you are testing. A wrong zone ID deploys the WAF rule to a different zone. Check Security → WAF → Custom Rules on your zone to confirm the rule appeared there.

**`POST /restore` returns 404**

Either `enableRecoveryWebhook` is `false` in `src/config.ts`, or you're sending the request to the wrong URL or with the wrong HTTP method. The endpoint only accepts `POST` on the exact path `/restore`.

**`POST /restore` returns 500**

`RECOVERY_SECRET` is not set. The Worker refuses `/restore` rather than accept a missing secret. Run `pnpm exec wrangler secret put RECOVERY_SECRET`, then try again.

**`POST /restore` returns 403**

The `Authorization` header is missing or the Bearer token doesn't match `RECOVERY_SECRET`. Double-check the secret with `pnpm exec wrangler secret list` — it won't show the value but confirms the secret exists.

**Email is not arriving**

- Check that Cloudflare Email Routing is enabled and active on your account
- Verify `destination_address` in `[[send_email]]` is listed as a verified address in Email Routing
- Verify `EMAIL_FROM` is a valid sender address for your domain (e.g. `anything@yourdomain.com`)
- Check that `EMAIL_FROM` and `EMAIL_TO` appear in the `[vars]` section of `wrangler.toml` and that you redeployed after adding them
- If any of the three vars are missing the worker silently skips email — it does not error

**Webhook alerts are not arriving**

- `ALERT_WEBHOOK_URL` must be set as a secret (`pnpm exec wrangler secret put ALERT_WEBHOOK_URL`) and be an `https` URL; anything else is skipped with a log line
- A non-2xx response from the service is logged as `webhook alert failed: Webhook returned HTTP <status>` — check `wrangler tail` or Workers Logs
- Email and webhook are independent, so one failing does not stop the other

**Purge ran but objects are still in R2 / rows are still in D1**

Check the alert (email or webhook) for per-bucket or per-table error lines. Common causes:
- `bindingName` in `config.ts` does not exactly match the `binding =` value in `wrangler.toml` (case-sensitive)
- The binding exists in `config.ts` but not in `wrangler.toml` — add it and redeploy
- The R2 prefix in `prefixes` does not match any object keys in the bucket
- The D1 table name in `tables` does not exist in the database

**`pnpm install` fails with a quarantine error**

The `.npmrc` enforces a 7-day quarantine on new package versions. See [step 2 of Manual setup](#2-install-dependencies).

**`wrangler deploy` says account ID or zone ID is invalid**

Make sure you replaced all three `REPLACE_ME_*` placeholders in `wrangler.toml`. The worker will refuse to deploy if the KV namespace ID is still the placeholder value.

---

## Contributing

Bug reports and PRs are welcome, though this is a free, volunteer-maintained project — response times are not guaranteed. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local dev workflow and review expectations.

## Security

To report a vulnerability, please **do not** open a public issue. Follow the process in [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).
