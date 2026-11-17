# Security policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use one of these private channels instead:

- Open a [GitHub Security Advisory](https://github.com/JanusKlok/Cloudflare-killswitch/security/advisories/new) (preferred — keeps the discussion linked to the repo)
- Or email the maintainer (see GitHub profile)

Please include:

- A description of the issue and the impact (what an attacker can do)
- Steps to reproduce, or proof-of-concept code
- The commit or release the issue was found against
- Any suggested mitigation, if you have one

## Response expectations

This is a free, volunteer-maintained open source project. There are **no guaranteed response times**. The maintainer will make a best-effort attempt to acknowledge and address confirmed security issues, but this project comes with no SLA, support contract, or commitment to a fixed disclosure timeline.

If you need guaranteed response times or a formal disclosure process, this tool may not be the right fit for your environment.

## Scope

In scope:

- Bypassing the kill-switch logic (e.g. causing the worker to fail to block traffic when it should, or fail to restore when authorised)
- Authentication weaknesses on `POST /restore`
- Leaking secrets through logs, error messages, or email or webhook content
- Injection vulnerabilities in API calls or the email/webhook subject and body
- Denial-of-service vectors that disable monitoring (e.g. crashing the cron tick)

Out of scope:

- Vulnerabilities in Cloudflare's own services (please report those to Cloudflare directly)
- Vulnerabilities in third-party dependencies — open an issue and let dependabot handle it unless it's actively exploited
- Misconfiguration that's clearly the operator's fault (e.g. committing the `RECOVERY_SECRET` to a public repo)

## Hardening already in place

For context — these are deliberate design choices the project already makes:

- 7-day supply-chain quarantine on dependencies (`minimum-release-age=10080`),
  with the pnpm version pinned via `packageManager` and a CI step that asserts
  each `.npmrc` setting is actually in effect (older pnpm ignores them silently)
- npm lifecycle scripts disabled by default (`ignore-scripts=true`)
- Exact version pinning, no caret/tilde ranges (`save-exact=true`)
- Non-registry transitive sources blocked (`block-exotic-subdeps=true`) and
  provenance downgrades refused (`trust-policy=no-downgrade`)
- GitHub Actions pinned to full commit SHAs, not mutable tags
- Constant-time comparison on the recovery secret
- Soft rate limit on `POST /restore` (10 requests per 60 seconds per client IP,
  every request counted, checked before authentication), using the Workers Rate
  Limiting binding `RESTORE_RATE_LIMITER`. Rate limiting never writes to KV, so
  unauthenticated traffic cannot spend the account's KV write quota — which is
  itself a monitored metric. Without the binding an in-memory per-isolate limiter
  is used and `pnpm run validate` warns
- Webhook alert URL (`ALERT_WEBHOOK_URL`) is kept as a secret, must be `https`,
  is never followed through redirects, and never appears in error messages or
  logs, since the URL itself is the credential
- `blocking.workers` records each Worker's `workers.dev` / preview-URL state
  before the kill and `blocking.r2` records each bucket's `r2.dev` state, and
  restore re-enables only what was on, so a kill and restore cannot make a
  private Worker or bucket public
- The kill-switch worker excludes itself from `blocking.workers: 'all'` mode
- WAF rule expression exempts `POST /restore` so the recovery path stays
  reachable, scoped to `RECOVERY_HOSTNAME` when set

### Known limitations

These are documented rather than fixed, and are in scope for reports that
demonstrate concrete impact:

- **A `/restore` racing a killed tick.** Killed ticks now write state when they
  block something new. If one runs at the same moment as a successful
  `POST /restore`, its write can land after the restore's and leave KV saying
  "killed" while traffic flows; later ticks then treat the account as already
  killed. The window is a few seconds; check the state after a manual restore
  (see "Verifying it works") if you restore close to a 5-minute boundary.

- The `/restore` rate limit is a soft cap. The binding's counts are per
  Cloudflare location and eventually consistent, the in-memory fallback is per
  isolate, and an attacker rotating source IPs gets a fresh window per IP. The
  32-byte `RECOVERY_SECRET` is the primary brute-force defense. On the Free plan
  (tested 2026-11-17) the binding began answering 429 after about 20 requests in
  a minute, not exactly 10.
- A bucket whose `r2.dev` state could not be read is blocked but left off at
  restore, to avoid making a private bucket public. It stays dark until the
  operator re-enables it by hand (the alert says which).
- `blocking.r2` turns off the `r2.dev` URL only. Buckets served through a connected
  custom domain, and S3-API access with R2 API tokens, are not blocked.
- While killed, a recorded Worker that is re-enabled by a redeploy (for example
  `wrangler deploy` with `workers_dev = true`), or a recorded Pages project that
  is redeployed, is not re-blocked. Workers, Pages projects and R2 buckets
  created after the kill are blocked on the next tick.
- `blocking.workers` disables the `workers.dev` subdomain only. A Worker served
  on a custom domain or route keeps serving unless a WAF rule covers its zone
  (`scope: 'zone'` / `'account'`).
- A remnant that can never be restored (a deleted Pages project, say) is
  retried on every 5-minute tick. Each retry costs a few API subrequests but no
  KV write while the remnant is unchanged, and the "Restore partly failed" alert
  is sent only when it changes. This is deliberate: capping the retries would
  permanently strand accounts that have `enableRecoveryWebhook: false` and so
  have no manual path back.
- On the Workers Free plan an invocation is capped at 50 subrequests. A quiet
  tick costs 1 (a single GraphQL request); the first kill adds a GET and a
  write per Worker, Pages project and R2 bucket, plus the WAF calls, and each
  killed tick adds list calls for any blocking set to `'all'`. Past roughly 20
  targets in total the budget can run out mid-kill; the failures are logged,
  reported in the alert, and retried on later ticks. Prefer explicit lists past
  that, or use a paid plan.
