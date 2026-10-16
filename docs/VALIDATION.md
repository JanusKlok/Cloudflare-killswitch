# Local validation — 2026-10-16

Passed on Node **24.19.0**, using locked Wrangler **4.150.0**:

- `npm run check`: release-age/source/integrity verification, registry signature
  verification, vulnerability audit, strict TypeScript check, **35 passing tests**
  and an ES module Worker build.
- Every one of **117 locked package versions** is older than **72 hours**; the
  youngest was over **80 hours** old at review. Every registry signature verified;
  **78** packages additionally had verified provenance attestations. No known
  vulnerabilities were reported. Lifecycle install scripts stayed disabled.
- `npm run dry-run`: successful local Wrangler bundle, **25.53 KiB upload /
  7.85 KiB gzip**. This is a bundle size measurement, not a CPU/memory benchmark.
- Local workerd run with a fake admin credential and deliberately invalid account
  placeholder: unauthenticated status returned 404; authenticated initial state
  returned 503; local cron ran; the configuration error and heartbeat persisted
  in local SQLite; status returned 503; invalid rearm was refused with 503.
  The local server was stopped after the check.

The tests cover pricing examples, integer rounding/overflow, CPU milliseconds,
shared allowances, D1 rows versus query counts, R2 classification, storage reserve,
billing/leap-year/timezone boundaries, stale/missing/truncated/error metrics,
threshold crossings, disabled enforcement, durable intent, partial failures,
retry/reconciliation after lost responses, WAF position, script/preview/cron
coverage, redeployment drift, original disabled settings, recovery checks,
authentication and concurrent control-object requests.

Lockfile SHA-256:

```text
e7a1a94a2f9f84d2ce297f62c85b737357ff92561b02552edcc70d9e7e32c638
```

No real Cloudflare token, account analytics, edge rule, production deployment or
live recovery was exercised. Customer schema/permissions, Images coverage,
background/direct-data clients, propagation and pipeline interlock require the
staging and ownership checks in [OPERATIONS.md](OPERATIONS.md). No final-invoice
cap or CPU/memory improvement is claimed.
