# Cloudflare Kill Switch

[![CI](https://github.com/JanusKlok/Cloudflare-killswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/JanusKlok/Cloudflare-killswitch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](./package.json)

A Cloudflare Worker that monitors your usage on a configurable schedule and automatically blocks all traffic — with optional data purge and email alerts — the moment any configured limit is crossed.

When a limit is hit, the worker:

1. Deploys a WAF Custom Rule that blocks every incoming request
2. Disables the `workers.dev` subdomain for configured Workers scripts (optional)
3. Deploys a 503 maintenance Worker to configured Pages projects (optional)
4. Sends an email alert with a full breach report (optional)
5. Optionally purges R2 objects or D1 table data if storage crosses a higher, opt-in threshold
6. Writes state to KV so subsequent cron ticks are instant no-ops
7. Automatically re-arms itself when your next Cloudflare billing period opens

A recovery endpoint (`POST /restore`) lets you lift the block immediately without touching the Cloudflare dashboard.

No external services, no runtime dependencies. Runs entirely on Cloudflare infrastructure.

---

## Table of contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Automated setup](#automated-setup-recommended)
- [Manual setup](#manual-setup)
- [Configuration reference](#configuration-reference)
- [Metrics and default limits](#metrics-and-default-limits)
- [Optional: email alerts](#optional-email-alerts)
- [Optional: Workers and Pages blocking](#optional-workers-and-pages-blocking)
- [Optional: destructive purge](#optional-destructive-purge)
- [Recovery](#recovery)
- [API token permissions](#api-token-permissions)
- [Local development and testing](#local-development-and-testing)
- [Extending: adding a new service](#extending-adding-a-new-service)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
On each cron tick (default: every 5 minutes, configurable in wrangler.toml):

  1. Read KV state
       → status is 'killed' and not the 1st of a new month → exit immediately
       → status is 'killed' and it's the 1st of a new month → remove WAF rule,
         reset to 'active', continue monitoring

  2. Query Cloudflare GraphQL Analytics API for current usage across
     Workers, Pages, KV, R2, and D1

  3. Compare every metric against its configured blockAt threshold

  4. If any threshold is breached:
       a. Deploy a WAF Custom Rule blocking all requests
          (POST /restore is exempted so you can still recover)
       b. Disable the workers.dev subdomain for configured Workers scripts
       c. Deploy a 503 Worker to configured Pages projects (saves current deployment ID)
       d. If an R2 metric exceeds purgeAt: run the configured R2 purge actions;
          if a D1 metric exceeds purgeAt: run the configured D1 purge actions
          (destructive — opt-in only; other services never trigger purges)
       e. Send email alert with breach details and all blocking results
       f. Write 'killed' state to KV including WAF rule ID, disabled Workers,
          and blocked Pages deployment IDs

POST /restore:
  1. Verify Authorization: Bearer <RECOVERY_SECRET>
  2. Roll back Pages projects to their pre-kill production deployments
  3. Re-enable the workers.dev subdomain for each disabled Workers script
  4. Delete the WAF rule via the Cloudflare API
  5. Write 'active' state to KV (on partial failure the state stays
     'killed' with only the failed items, so a retry picks them up)
  6. Return { restored: true, previousReason: "..." }
```

State is a small JSON object in KV:

```json
{
  "status": "killed",
  "timestamp": "2026-05-08T14:32:00.000Z",
  "reason": "2 block breach(es)",
  "wafRuleId": "abc123",
  "wafRulesetId": "def456",
  "disabledWorkerScripts": ["my-app-worker"],
  "blockedPagesProjects": [
    { "project": "my-site", "previousDeploymentId": "deploy-abc123" }
  ]
}
```

All IDs are stored so `POST /restore` can undo each action precisely — no manual dashboard work needed.

---

## Prerequisites

- **A Cloudflare account** with at least one active zone (domain pointing to Cloudflare)
- **Node.js 22+** and **pnpm** (`npm install -g pnpm`)
- **Wrangler CLI** — installed automatically as a dev dependency; use `pnpm exec wrangler` or add it to your PATH

> **Free plan vs Enterprise:** The default `scope: 'zone'` in `config.ts` deploys WAF rules to a single zone and works on the **free plan**. Setting `scope: 'account'` deploys an account-wide WAF rule and **requires an Enterprise plan** (account-level custom rulesets are Enterprise-only). If your account has no domain at all (`workers.dev` / `pages.dev` only), use `scope: 'none'` together with `blocking.workers` / `blocking.pages`. Most users with a domain should leave this at `'zone'`.

---

## Automated setup (recommended)

The setup scripts handle everything interactively: creating the KV namespace, filling in `wrangler.toml`, setting secrets, and deploying. You just answer the prompts.

**Before running the script**, make sure you are authenticated with Wrangler:

```
pnpm exec wrangler login
```

**macOS / Linux:**

```
bash setup.sh
```

**Windows (PowerShell):**

```
.\setup.ps1
```

The script will ask for your Account ID, Zone ID, API token, and walk you through each optional feature. At the end it offers to deploy immediately.

> If you chose to generate a recovery secret automatically, the script prints it at the end. **Save it somewhere safe** — you will need it to call `POST /restore`.

---

## Manual setup

If you prefer full control over each step, or want to understand exactly what the script does, follow the instructions below.

**Required for any deployment:** steps 1–5 (code, dependencies, KV namespace, wrangler.toml placeholders, API token). Steps 6 and 7 have sensible defaults — read them, but you may not need to change anything.

| What | Required? |
|------|-----------|
| KV namespace + wrangler.toml placeholders | Yes |
| `CLOUDFLARE_API_TOKEN` secret | Yes |
| `RECOVERY_SECRET` secret | Only if keeping `enableRecoveryWebhook: true` (the default) |
| Email setup | No — silently skipped if not configured |
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

**Optional — only needed if you keep `enableRecoveryWebhook: true` in config.ts (the default):**

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

Store it in a password manager. If you don't want the recovery webhook at all, set `enableRecoveryWebhook: false` in `config.ts` and skip this secret entirely.

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
- Keep the block in place until you manually restore — set `autoResetOnBillingCycle: false`
- Disable the recovery webhook entirely — set `enableRecoveryWebhook: false` (and skip `RECOVERY_SECRET` in step 5)

See the [Configuration reference](#configuration-reference) for full details on every option.

### 7. Deploy

At this point the worker is fully functional. Email alerts and data purge can be added later without redeploying from scratch — they are configured and enabled independently.

```
pnpm typecheck   # optional — catches type errors before deploy
pnpm test        # optional — runs the test suite against Miniflare
pnpm run deploy
```

`pnpm run deploy` first validates your configuration and only then runs `wrangler deploy`. The validator cross-checks `src/config.ts` against `wrangler.toml` and reports concrete fixes for anything that would break the deploy — or worse, make the kill switch silently do nothing when it fires (placeholder IDs, a missing zone ID with `scope: 'zone'`, `scope: 'none'` with no blocking configured, purge targets without matching bindings, and so on). It also prints the exact API-token permissions your configuration needs. You can run the check on its own at any time:

```
pnpm run validate
```

After deploying, confirm the cron trigger is registered: **Workers & Pages → cloudflare-killswitch → Triggers → Cron Triggers**.

The polling interval is set in `wrangler.toml` under `[triggers] crons`. The default is `*/5 * * * *` (every 5 minutes). Change it to any valid cron expression before deploying if you want a different cadence.

### 8. Verify it's working

Check the live worker logs:

```
pnpm exec wrangler tail
```

Trigger a cron tick manually (the response body is empty — check the logs):

```
curl "https://your-worker.your-subdomain.workers.dev/__scheduled?cron=*%2F5+*+*+*+*"
```

Replace `*%2F5+*+*+*+*` with your configured cron expression (URL-encoded).

Inspect the current KV state:

```
pnpm exec wrangler kv key get --namespace-id YOUR_KV_NAMESPACE_ID state
```

If the worker is running normally and no limits are breached, the state will be `null` (empty KV) or `{"status":"active",...}`.

---

## Configuration reference

All configuration lives in `src/config.ts`, your untracked copy of `src/config.example.ts`. The file is TypeScript — your editor will catch type errors.

```ts
export const CONFIG: AppConfig = {
  scope: 'zone',
  billingCycleDay: 1,
  autoResetOnBillingCycle: true,
  enableRecoveryWebhook: true,
  limits: { workers, pages, kv, r2, d1 },
  purgeConfig: { r2: [], d1: [] },
  blocking: { workers: [], pages: [] },
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

- **Auto-reset timing** — when `autoResetOnBillingCycle` is on
- **Per-cycle metric windows** — R2 Class A/B operations, and the KV / R2 / D1
  storage ceilings

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

When `true`, the worker automatically removes the WAF block and resets to
`active` once the kill event falls in a **previous billing period** — that is, on
the first cron tick on or after day `billingCycleDay` of the month.

It is deliberately not gated on the anniversary day itself: if the Worker is down
for the whole of that day, it still recovers on the next tick rather than waiting
another full cycle.

Set to `false` if you want the block to remain indefinitely until you call
`POST /restore` manually. Useful if you want to investigate a breach before
re-enabling traffic.

### enableRecoveryWebhook

```ts
enableRecoveryWebhook: boolean  // default: true
```

When `true`:
- The worker handles `POST /restore` requests authenticated with `RECOVERY_SECRET`
- The WAF block rule expression exempts `POST /restore` so the endpoint remains reachable even while traffic is blocked

When `false`:
- `POST /restore` returns 404
- The WAF rule blocks **all** traffic without exception
- The only recovery path is manually deleting the WAF rule in the Cloudflare dashboard (Security → WAF → Custom Rules)

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

**KV**

```ts
kv: {
  reads:        { blockAt: 100_000 },       // read ops / day   (free tier: 100,000)
  writes:       { blockAt: 1_000 },         // write ops / day  (free tier: 1,000)
  storageBytes: { blockAt: 1_073_741_824 }, // storage in bytes (free tier: 1 GB)
  //   reads and writes: window = UTC calendar day
  //   storageBytes:     window = current billing cycle (see billingCycleDay)
}
```

**R2**

```ts
r2: {
  storageBytes: { blockAt: 10_737_418_240 }, // storage in bytes  (free tier: 10 GB / month)
  classAOps:    { blockAt: 1_000_000 },      // Class A ops / month (free tier: 1M)
  classBOps:    { blockAt: 10_000_000 },     // Class B ops / month (free tier: 10M)
  //   All R2 metrics: window = current billing cycle (see billingCycleDay)
}
```

Class A operations are mutating: `PUT`, `DELETE`, `LIST`. Class B are read operations: `GET`, `HEAD`.

**D1**

```ts
d1: {
  rowReads:     { blockAt: 5_000_000 },      // row reads / day   (free tier: 5M)
  rowWrites:    { blockAt: 100_000 },        // row writes / day  (free tier: 100,000)
  storageBytes: { blockAt: 5_368_709_120 },  // storage in bytes  (free tier: 5 GB / month)
  //   rowReads and rowWrites: window = UTC calendar day
  //   storageBytes:           window = current billing cycle (see billingCycleDay)
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
}
```

Controls which additional resources are blocked when the kill switch fires. Both are **empty by default** — the WAF rule handles traffic on your custom domain and no additional action is taken on `workers.dev` or `pages.dev` subdomains unless you configure them here.

**`blocking.workers`**

| Value | Effect |
|-------|--------|
| `[]` (default) | Workers scripts are left untouched |
| `'all'` | Every deployed Workers script **except the kill-switch itself** has its `workers.dev` subdomain disabled |
| `['script-a', 'script-b']` | Only the named scripts have their `workers.dev` subdomain disabled |

The kill-switch Worker is always excluded from `'all'` mode — disabling it would make the `POST /restore` endpoint unreachable via `workers.dev`.

```ts
// Disable all workers.dev subdomains on kill:
blocking: { workers: 'all', pages: [] }

// Or, target specific scripts by name:
blocking: { workers: ['my-api-worker', 'my-auth-worker'], pages: [] }
```

On restore (via `POST /restore` or auto-reset), all previously disabled scripts have their `workers.dev` subdomain re-enabled automatically.

**`blocking.pages`**

Pages projects to block when the kill switch fires. Each project receives a new deployment containing a minimal Worker that returns `503 Service Temporarily Unavailable` for every request. The current production deployment ID is saved first so it can be restored precisely.

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

**API token permissions required:** If `blocking.workers` or `blocking.pages` is non-empty, your API token needs additional permissions beyond the WAF rule. See [API token permissions](#api-token-permissions).

---

## Metrics and default limits

| Service | Metric | Billing window | Free-tier limit |
|---------|--------|---------------|-----------------|
| Workers | requests | Daily (UTC midnight → now) | 100,000 / day |
| Pages | invocations (Functions only) | Daily | 100,000 / day |
| KV | reads | Daily | 100,000 / day |
| KV | writes | Daily | 1,000 / day |
| KV | storage | Monthly (1st UTC midnight → now) | 1 GB |
| R2 | storage | Monthly | 10 GB |
| R2 | Class A operations | Monthly | 1,000,000 |
| R2 | Class B operations | Monthly | 10,000,000 |
| D1 | row reads | Daily | 5,000,000 / day |
| D1 | row writes | Daily | 100,000 / day |
| D1 | storage | Monthly | 5 GB |

**Window alignment:** The worker uses the same time windows Cloudflare uses for billing. Daily metrics query from UTC midnight of the current day to now. Per-cycle metrics query from UTC midnight of the day the current billing period opened (see [`billingCycleDay`](#billingcycleday)) to now — with `billingCycleDay: 1` that is the 1st of the calendar month.

**Analytics lag:** Cloudflare's GraphQL Analytics API has a pipeline delay of roughly 1–2 minutes. Usage values seen by the worker may be slightly behind real-time.

**D1 storage aggregation:** The D1 storage metric is the total across all D1 databases on the account, because Cloudflare bills it as a single account-level quota.

---

## Optional: email alerts

When the kill switch fires, it can email you a full report listing every breached metric, the WAF rule IDs, and any purge results. Email requires **Cloudflare Email Routing** to be configured on your account.

### Setup

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

If any of `SEND_EMAIL`, `EMAIL_FROM`, or `EMAIL_TO` are absent, email is silently skipped. The kill switch still fires and traffic is still blocked — you just won't get a notification.

### What the alert looks like

```
Subject: [Kill Switch] Traffic blocked — limits breached

Kill Switch triggered. WAF block rule deployed.

Breaches detected:
  - workers.requests (day): 127,543 observed, limit 100,000 [BLOCK]
  - r2.storageBytes (month): 10.84 GB observed, limit 10.00 GB [PURGE]

WAF rule ID : abc123def456
WAF ruleset : ghi789jkl012
Scope       : zone

R2 purge results:
  MY_UPLOADS_BUCKET: deleted 1,204 object(s)

To restore: POST /restore with Authorization: Bearer <RECOVERY_SECRET>
```

---

## Optional: Workers and Pages blocking

By default, the kill switch only deploys a WAF Custom Rule. Traffic on your custom Cloudflare-proxied domains is immediately blocked, but `workers.dev` and `pages.dev` subdomains are **not** affected by WAF rules.

> **The reverse gap matters too.** `blocking.workers` disables a script's
> `workers.dev` subdomain and nothing else — a Worker served on a **custom
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

- `'all'` discovers all deployed Workers scripts via the Cloudflare API and disables the `workers.dev` subdomain for each one, **excluding the kill-switch itself** (so `POST /restore` remains reachable).
- An explicit `string[]` disables only the named scripts.

Workers subdomain state is saved to KV. On restore, every previously disabled script has its `workers.dev` subdomain re-enabled automatically.

**API token requirement:** Add `Account → Workers Scripts → Edit` to your token.

### Block pages.dev subdomains

```ts
blocking: {
  workers: [],
  pages: ['my-marketing-site', 'my-app-frontend'],
},
```

When the kill switch fires:
1. The current production deployment ID is fetched from the Cloudflare Pages API and saved to KV.
2. A new deployment is pushed to the project containing a single Worker module that returns `503 Service Temporarily Unavailable` for every request.

On restore, each project is rolled back to its saved production deployment via the Pages rollback API. The 503 deployment is discarded.

**API token requirement:** Add `Account → Cloudflare Pages → Edit` to your token.

### Combining both

```ts
blocking: {
  workers: 'all',
  pages: ['my-marketing-site'],
},
```

Workers and Pages blocking run in parallel and are both best-effort — a failure in one does not prevent the other from executing. The WAF rule always fires first regardless.

**Free-plan subrequest limit:** on the Workers Free plan each invocation is capped at 50 subrequests, and every Cloudflare API call, KV operation, and R2 list/delete made during a kill counts against it. A kill with `workers: 'all'` and `pages: 'all'` on an account with many scripts and projects — especially combined with an R2/D1 purge — can exceed the cap, leaving some scripts or projects unblocked (their failures are logged and skipped). If you have more than roughly 30 scripts + projects combined, prefer explicit lists of the ones that matter, or run the kill switch on a paid plan (10,000 subrequests).

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

Tables are processed in the order listed. If one table fails, the rest still run. Errors are reported in the email alert.

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

### Auto-reset (start of the billing cycle)

With `autoResetOnBillingCycle: true` (the default), the worker automatically
recovers once a new billing period opens, provided:

- The current KV state is `killed`
- `billingCycleDay` is a valid integer 1–31
- The original kill time falls in a previous billing period

On the first cron tick on or after day `billingCycleDay`:
1. Pages projects are rolled back to their pre-kill deployments (if any were blocked)
2. Workers scripts have their `workers.dev` subdomain re-enabled (if any were disabled)
3. The WAF rule is deleted via the Cloudflare API
4. KV state is set to `active`
5. Normal usage monitoring resumes

This aligns with Cloudflare's billing reset — your limits refill when the new
period opens, so the worker unlocks then too. The original kill time is preserved
across failed restore attempts, so a partial failure retries on the next tick
instead of suppressing auto-reset for the rest of the period.

### Manual restore via webhook

Call `POST /restore` from anywhere with your `RECOVERY_SECRET`:

```
POST https://cloudflare-killswitch.<your-subdomain>.workers.dev/restore
Authorization: Bearer YOUR_RECOVERY_SECRET
```

Using curl:

```
# Linux / macOS:
curl -s -X POST https://cloudflare-killswitch.your-subdomain.workers.dev/restore \
     -H "Authorization: Bearer YOUR_RECOVERY_SECRET" | jq

# Windows PowerShell:
curl -s -X POST https://cloudflare-killswitch.your-subdomain.workers.dev/restore `
     -H "Authorization: Bearer YOUR_RECOVERY_SECRET"
```

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

Only the failed items remain recorded in the killed state — call `POST /restore` again to retry just those.

The call is idempotent — if the worker is already `active`, it returns `200` with `restored: true` anyway. Requests are rate-limited to 10 per minute per client IP (`429` with a `Retry-After` header beyond that).

The `POST /restore` endpoint is **exempt from the WAF block rule** when `enableRecoveryWebhook: true`, so it remains reachable even while all other traffic is blocked.

**Finding your worker URL:** After `wrangler deploy`, the URL is printed in the output. It follows the pattern `https://cloudflare-killswitch.<your-subdomain>.workers.dev`. You can also find it in the dashboard under Workers & Pages → cloudflare-killswitch → Settings → Domains & Routes.

If you've lost your `RECOVERY_SECRET`, set a new one and redeploy:

```
pnpm exec wrangler secret put RECOVERY_SECRET
pnpm run deploy
```

---

## API token permissions

Create a **Custom Token** at `dash.cloudflare.com/profile/api-tokens`. Click "Create Token" → "Get started" (custom token).

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

The token does not need explicit read permissions for analytics — Cloudflare GraphQL Analytics access is included with zone/account membership.

Scope the token to specific zones or accounts where possible to follow the principle of least privilege. After creating the token, copy it immediately — Cloudflare only shows it once.

---

## Local development and testing

### Running tests

The test suite runs against Miniflare (Cloudflare's local Workers runtime) — no real account or API token needed:

```
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

Test the restore endpoint:

```
curl -X POST http://localhost:8787/restore -H "Authorization: Bearer any-local-secret"
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

**`src/config.ts`** — add defaults:

```ts
limits: {
  // ... existing services ...
  myservice: {
    requests: { blockAt: 50_000 },
  },
},
```

**`src/metrics/myservice.ts`** — implement the module:

```ts
import type { AppConfig, Breach, MetricSample, ServiceModule } from '../types.js';
import type { Env } from '../types.js';
import { gql } from '../graphql/client.js';
import { utcDayStart, utcNow } from '../graphql/queries.js';

const QUERY = `
  query MyServiceUsage($accountId: String!, $since: String!, $until: String!) {
    viewer {
      accounts(filter: { accountTag: $accountId }) {
        myServiceDataset(filter: { datetime_geq: $since, datetime_leq: $until }) {
          sum { requests }
        }
      }
    }
  }
`;

export const myServiceModule: ServiceModule = {
  name: 'myservice',

  async fetchUsage(env: Env, cfg: AppConfig): Promise<MetricSample[]> {
    const data = await gql</* response type */>(env, QUERY, {
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      since: utcDayStart(),
      until: utcNow(),
    });
    const requests = data?.viewer?.accounts?.[0]?.myServiceDataset?.[0]?.sum?.requests ?? 0;
    return [{ metric: 'requests', value: requests, window: 'day' }];
  },

  evaluate(samples: MetricSample[], cfg: AppConfig): Breach[] {
    const breaches: Breach[] = [];
    for (const sample of samples) {
      const threshold = cfg.limits.myservice[sample.metric as keyof typeof cfg.limits.myservice];
      if (!threshold) continue;
      if (sample.value >= (threshold.purgeAt ?? Infinity)) {
        breaches.push({ service: 'myservice', metric: sample.metric, observed: sample.value,
                        limit: threshold.purgeAt!, severity: 'purge', window: sample.window });
      } else if (sample.value >= threshold.blockAt) {
        breaches.push({ service: 'myservice', metric: sample.metric, observed: sample.value,
                        limit: threshold.blockAt, severity: 'block', window: sample.window });
      }
    }
    return breaches;
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

Either `enableRecoveryWebhook` is `false` in `config.ts`, or you're sending the request to the wrong URL or with the wrong HTTP method. The endpoint only accepts `POST` on the exact path `/restore`.

**`POST /restore` returns 403**

The `Authorization` header is missing or the Bearer token doesn't match `RECOVERY_SECRET`. Double-check the secret with `pnpm exec wrangler secret list` — it won't show the value but confirms the secret exists.

**Email is not arriving**

- Check that Cloudflare Email Routing is enabled and active on your account
- Verify `destination_address` in `[[send_email]]` is listed as a verified address in Email Routing
- Verify `EMAIL_FROM` is a valid sender address for your domain (e.g. `anything@yourdomain.com`)
- Check that `EMAIL_FROM` and `EMAIL_TO` appear in the `[vars]` section of `wrangler.toml` and that you redeployed after adding them
- If any of the three vars are missing the worker silently skips email — it does not error

**Purge ran but objects are still in R2 / rows are still in D1**

Check the email alert for per-bucket or per-table error lines. Common causes:
- `bindingName` in `config.ts` does not exactly match the `binding =` value in `wrangler.toml` (case-sensitive)
- The binding exists in `config.ts` but not in `wrangler.toml` — add it and redeploy
- The R2 prefix in `prefixes` does not match any object keys in the bucket
- The D1 table name in `tables` does not exist in the database

**`pnpm install` fails with a quarantine error**

The `.npmrc` contains `minimum-release-age=10080` which blocks packages published less than 7 days ago. Wait until the package is 7 days old, or temporarily comment out that line in `.npmrc` for the install.

**`wrangler deploy` says account ID or zone ID is invalid**

Make sure you replaced all three `REPLACE_ME_*` placeholders in `wrangler.toml`. The worker will refuse to deploy if the KV namespace ID is still the placeholder value.

---

## Contributing

Bug reports and PRs are welcome, though this is a free, volunteer-maintained project — response times are not guaranteed. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local dev workflow and review expectations.

## Security

To report a vulnerability, please **do not** open a public issue. Follow the process in [SECURITY.md](./SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE).
