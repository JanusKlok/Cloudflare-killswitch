# Final security and correctness review — 2026-10-16

Reviewed the feature branch at `733fe01` and fixed the following issues. The
configuration example still has `enabled=false`. No production configuration,
application repository, deployment pipeline, default branch or PR was changed.

| Finding                                                                                                                             | Resolution                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slow analytics/WAF calls could exhaust the shared tick budget before other shutdown actions ran                                     | Separate preflight and shutdown budgets. At most five independent actions run concurrently; each action verifies its own result. Duplicate zone/host configuration is rejected.                                                                  |
| Manual cutoff waited on analytics/inventory even though no cost decision was needed                                                 | Persist intent and begin shutdown immediately, without those reads. Refresh coverage on the following cron.                                                                                                                                      |
| A later, lower analytics result could make a known spend cutoff eligible for recovery                                               | Retain each product's highest saved estimated charge line items in its current billing interval. Recovery uses the same floor. Verified interval changes reset that product only.                                                                |
| Restoring production before discovering that rearm was ineligible could leave the app open with cron paused                         | Add read-only `/recovery-check` before restoration. Require enabled enforcement, unchanged original control scope, complete valid snapshots, covered pricing/entrypoints and fresh cost below warning. On failed rearm, resume cron immediately. |
| Malformed cron, CPU-limit, response-envelope or durable-state values could be accepted, misrepresented or lose recovery information | Validate before recording/mutating. Require explicit REST success, distinguish missing WAF from permission errors, and reject unknown/legacy pricing models. Corrupt durable state returns 503; it does not become a fresh active state.         |
| Concurrent shutdown snapshot writes could otherwise overwrite newer recovery information                                            | Capture immutable records and serialize durable writes; mutation waits for its snapshot write to succeed. Lost responses reconcile on the following tick.                                                                                        |
| HTTP success could obscure a partial cutoff or disabled protection                                                                  | Partial failures return 503; disabled manual cutoff returns 409 when otherwise healthy; observe-mode status returns 503 with `enforcementEnabled=false`. Cron operation errors produce failed execution status.                                  |
| Admin secret comparison/short credentials needed hardening                                                                          | Require 32–512 characters and use Workers' timing-safe buffer comparison after equal-byte-length validation. Config parse errors never echo raw JSON.                                                                                            |

Regression cases include stalled WAF requests, exhausted preflight, failed
snapshot/archive/final-state writes, lost subdomain and cron responses, malformed
settings, changed scope, disabled enforcement, corrupted state, same-period cost
regression, verified period rollover, nullable GraphQL errors, permissions,
authentication, and HTTP failure signaling. No dependency was added or updated.

The original limits still apply: analytics can lag/sample; unknown/background
entrypoints and direct R2 clients require live customer review; Images remains
unpriced; the Ferrecar deployment interlock needs separate approval; retained
storage and subscriptions continue after shutdown. Live API permissions, schema
availability, edge propagation and staging recovery have not been tested.
A same-account monitor is not independent and cannot guarantee a US$25 invoice.

See [VALIDATION.md](VALIDATION.md) for the final checks and
[OPERATIONS.md](OPERATIONS.md) for the revised recovery procedure. The Workers
comparison API is documented in [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal).
