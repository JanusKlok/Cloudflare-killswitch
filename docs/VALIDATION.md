# Local validation — 2026-10-16

Passed on Node **24.19.0**, using locked Wrangler **4.150.0**:

- `npm run check`: release-age/source/integrity verification, registry signature
  verification, vulnerability audit, strict TypeScript check, **56 passing tests** (21 final-review regression cases added)
  and an ES module Worker build.
- Every one of **117 locked package versions** is older than **72 hours**; the
  youngest was over **80 hours** old at initial review. The unchanged lock tree's initial audit verified 117 registry signatures and 78 attestations; the follow-up audit of 43 installed packages verified all 43 signatures and 24 attestations. No known
  vulnerabilities were reported. Lifecycle install scripts stayed disabled.
- `npm run dry-run`: successful local Wrangler bundle, **34.66 KiB upload /
  9.93 KiB gzip**. This is a bundle size measurement, not a CPU/memory benchmark.
- Local workerd run with a fake 32+ character admin credential and deliberately invalid account
  placeholder: unauthenticated status returned 404; authenticated initial state
  returned 503; valid native timing-safe auth passed and an equal-length wrong secret was refused; local cron reported failure (500); the configuration error and heartbeat persisted
  in local SQLite; status remained unarmed/503; cutoff, recovery readiness and rearm were refused with 503.
  The local server was stopped after the check.

The tests cover pricing examples, integer rounding/overflow, CPU milliseconds,
shared allowances, D1 rows versus query counts, R2 classification, storage reserve,
billing/leap-year/timezone boundaries, stale/missing/truncated/error metrics,
threshold crossings, disabled enforcement, durable intent, partial failures,
retry/reconciliation after lost responses, WAF position, script/preview/cron
coverage, redeployment drift, original disabled settings, recovery checks,
authentication and concurrent control-object requests. The final review also covers independent shutdown budgets, slow WAF fairness, immutable snapshot writes, same-period cost floors and recovery write failures. See [FINAL-REVIEW.md](FINAL-REVIEW.md).

Lockfile SHA-256:

```text
e7a1a94a2f9f84d2ce297f62c85b737357ff92561b02552edcc70d9e7e32c638
```

No real Cloudflare token, account analytics, edge rule, production deployment or
live recovery was exercised. Customer schema/permissions, Images coverage,
background/direct-data clients, propagation and pipeline interlock require the
staging and ownership checks in [OPERATIONS.md](OPERATIONS.md). No final-invoice
cap or CPU/memory improvement is claimed.
