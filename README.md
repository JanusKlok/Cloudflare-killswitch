# Ferrecar Budget Guard

A small TypeScript Cloudflare Worker with a persistent, serialized cutoff latch.
It estimates shared-account Workers Standard, D1 and R2 Standard costs, warns at
**US$10**, and requests cutoff at **US$15**, including fixed fees and reserves.
Those are configurable, provisional thresholds. **This cannot guarantee a final
invoice of US$25 or less.** It preserves the application's code, D1 data and R2
objects. Enforcement ships **disabled**.

The reference Ferrecar Worker includes an **Images** binding, which is not priced
here. Live inventory, billing-window confirmation, account-specific analytics
validation and a separate deployment interlock remain prerequisites to approval.

## Review and setup

- [Setup, exact permissions, deployment and manual recovery](docs/OPERATIONS.md)
- [Pricing sources, upstream findings and coverage limits](docs/EVIDENCE.md)
- [Hook/dependency security review](docs/SECURITY-REVIEW.md)
- [Configuration with placeholders](wrangler.example.toml)

```sh
npm ci --ignore-scripts
npm run verify-dependencies
npm run check
npm run dry-run
```

Node 22+; no runtime dependencies. Dependencies are exact-pinned and locked.
The verification gate enforces a **72-hour minimum publication age for every
locked package**, including transitive/optional packages. Registry metadata or
integrity failure blocks validation. No Git hook or deployment automation is
installed by this repository.

A cron check runs every minute by default. It estimates account-level usage so
shared allowances are deducted once; retains a pessimistic CPU/storage envelope;
and, when explicitly enabled, latches on cutoff or missing/stale/invalid metrics.
It adds/verifies a dedicated-host WAF rule, disables the target workers.dev and
preview URLs, and clears target cron schedules. It verifies and retries partial
shutdowns each minute. Unsupported public/background entrypoints remain explicit
coverage gaps. There is no purge or automatic production reactivation.

One SQLite Durable Object coordinates concurrent checks and persists restoration
information before mutations. The monitor shares the Cloudflare account; its
availability and overhead are not independent or guaranteed. The default CPU
ceiling is intentionally very conservative and may shut down after a few hundred
app invocations. Read the setup guide before choosing a practical lower ceiling.

`GET /status`, `POST /cutoff` and `POST /rearm` require the separate admin secret.
Rearm verifies that an operator already restored the recorded settings; it does
not reopen production itself. Keep the guard's Durable Object namespace/instance
stable across releases. A Ferrecar deployment pipeline interlock is documented
for separate approval; this branch makes no changes to that pipeline.

## Attribution

Fork of [JanusKlok/Cloudflare-killswitch](https://github.com/JanusKlok/Cloudflare-killswitch)
at `9aeefaf17a01ae28cdea683c1eb552a3fa9cbb03`. The MIT license and original
copyright are preserved. This branch replaces the generic upstream runtime,
setup scripts and tests with a Ferrecar-specific implementation. Upstream history
is retained. It does not copy or rewrite Ferrecar's frontend or backend.
