# Evidence and limitations

Reviewed on 2026-10-16. This is a best-effort cost guard, not a Cloudflare-enforced
hard cap. A final invoice <= US$25 cannot be guaranteed: analytics lag, bursts,
sampling, independent entrypoints, API/control failures, active work, retained
storage, taxes and subscriptions can exceed the remaining headroom.

## Upstream review

Fork ancestry: [JanusKlok/Cloudflare-killswitch](https://github.com/JanusKlok/Cloudflare-killswitch),
revision `9aeefaf17a01ae28cdea683c1eb552a3fa9cbb03` (2.0.0).
The MIT license/copyright are retained. This branch replaces the generic runtime
and setup/deployment scripts; upstream history remains available.

| Finding at that revision                                                | Decision here                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/metrics/workers.ts` counts requests only, over a UTC day           | Add account-period requests and pessimistic CPU envelope                                                        |
| `src/scheduled.ts` logs metric-only failures and leaves traffic running | Armed scope latches cutoff on metric/coverage/configuration failure                                             |
| Worker blocking toggles `enabled` only                                  | Disable and read back both `enabled` and `previews_enabled`; exact-host WAF covers listed routes/custom domains |
| Killed state exits early, so partial shutdown can remain unfinished     | Reconcile and verify each action on every subsequent cron                                                       |
| Optional R2/D1 purges delete customer data                              | Remove purge implementation, bindings, setup options and execution paths                                        |
| Automatic billing-period reset is enabled by default                    | No automatic reactivation; explicit verified operator rearm                                                     |
| R2 deletion/list operations are misclassified                           | Listing is Class A; documented deletion/abort operations free; unknown action fails                             |

The reference Ferrecar Worker includes an Images binding. No source was copied
from that private repository, and no changes were made there. This is evidence of
a coverage requirement, not evidence of its current deployed settings.

## Rate card and estimation

All money is integer micro-US dollars (1 USD = 1,000,000). Integer BigInt
intermediates and upward rounding avoid arithmetic undercount. These are public
standard paid-plan rates; Enterprise/legacy models and custom contracts are
unsupported.

| Dimension           | Shared account inclusion | Overage                                |
| ------------------- | ------------------------ | -------------------------------------- |
| Workers requests    | 10 million/month         | $0.30/million                          |
| Workers CPU         | 30 million CPU-ms/month  | $0.02/million CPU-ms                   |
| D1 rows read        | 25 billion/month         | $0.001/million rows                    |
| D1 rows written     | 50 million/month         | $1/million rows                        |
| D1 storage          | 5 GB                     | $0.75/GB-month                         |
| R2 Standard Class A | 1 million/month          | $4.50/million, whole unit rounded up   |
| R2 Standard Class B | 10 million/month         | $0.36/million, whole unit rounded up   |
| R2 Standard storage | 10 GB-month/month        | $0.015/GB-month, whole unit rounded up |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing and operation definitions](https://developers.cloudflare.com/r2/pricing/).
The fixed charge configuration includes at least the full $5 Workers subscription.
The provisional warning is $10 and cutoff is $15 **including** fixed charges and
reserve; neither is a guaranteed safe limit. R2 IA/retrieval, Images, KV, logs,
Queues, Workflows, AI, other subscriptions and taxes need explicit review. The
guard never labels the covered estimate as an account invoice total.

Each dataset is queried at account level, so an inclusion is subtracted once,
not once per app/database/bucket. Historical other Workers remain in analytics.
Guard requests remain in the shared request count. Guard Worker CPU and Durable
Object request/duration/SQLite storage overhead are reserved separately (at least
$1 configured), not measured or guaranteed capped. See [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

CPU = non-guard account invocations * configured `cpuCeilingMs`, in **milliseconds**.
No CPU percentile is multiplied by requests and presented as a CPU sum. The
default 1,800,000 ms allows 2x the documented 15-minute maximum background CPU,
and often overestimates severely. A lower HTTP-only ceiling requires independent
historic entrypoint review and observed platform CPU limit with 2x margin.
Runtime rollover and sampling mean even this is an estimate, not a formal bound.
There is no measured CPU/memory improvement claim and no Rust/Bun runtime rewrite.
See [Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
and [sampled CPU quantiles](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

Storage reserves the **sum of each resource's peak** over the period for the
**entire** period, including remaining days, and takes the larger configured
floor. R2 includes payload plus metadata to avoid under-reserving; unobserved
multipart/other storage must be included in the floor after review. This is more
conservative than integrating daily peaks/monthly averages, provided analytics
include the true peaks. It does not predict future storage growth or charges in
future billing periods. Decimal 1e9 bytes/GB deliberately avoids a binary-unit
undercount. D1 rows are not query counts; indexes and scan work matter.

## Windows, fields, freshness and sampling

[Billable usage](https://developers.cloudflare.com/billing/manage/billable-usage/)
aligns to the customer's billing subscription, not a guessed calendar month;
multiple subscriptions can have different cycles. Configuration requires exact
verified start/end timestamps separately for Workers, D1 and R2, and expires at
the next boundary. No anniversary-day clamping or automatic reactivation is used.
D1's date-granularity query encloses the UTC start day conservatively, potentially
including earlier hours on that day for a non-midnight interval.

The single bounded GraphQL POST selects eight datasets/aliases, no object names,
SQL strings, logs or object bodies:

- `workersInvocationsAdaptive.sum.requests`, grouped by script;
  a second alias fetches only the latest guard timestamp as ingestion canary.
- `d1AnalyticsAdaptiveGroups.sum.rowsRead/rowsWritten`;
  `d1StorageAdaptiveGroups.max.databaseSizeBytes` by database ID plus recent
  database presence. This is the billing row metric, not read/write query count.
- `r2OperationsAdaptiveGroups.sum.requests` by action;
  `r2StorageAdaptiveGroups.max.payloadSize/metadataSize` by bucket plus recent
  target storage timestamp. Statuses are not filtered out, conservatively.

The official [Workers query example](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/),
[D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[R2 metrics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
and [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)
document the selected fields and retention constraints. There is no authenticated
live schema/introspection evidence for the customer's account. Observing a valid
full-period response before enforcement is required; unavailable fields, access
limits and truncated results fail visibly instead of being treated as zero.
R2/D1 have a 31-day query/retention constraint; the guard refuses longer intervals.

The guard requires its canary within 15 minutes, R2 target storage within 48 hours
and D1 target storage presence today/yesterday. The provider publishes no
end-to-end freshness guarantee that makes these billing-safe. These checks detect
some stale streams, not a coherent billing watermark; a recent canary does not
prove all older metrics have finished arriving. Quiet/empty storage datasets
can cause a deliberate protective outage. No missing metric becomes zero.
Adaptive sampling can undercount and delayed updates can still evade detection.

## Cutoff coverage

| Entrypoint/cost                                                       | Implemented behavior                                                           | Limit                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Dedicated zone host routes/custom domains                             | Exact-host WAF block at first rule, before Worker invocation where WAF applies | Only configured zones/hosts; staging edge test still required           |
| workers.dev production and preview/version URLs                       | Both script subdomain booleans disabled and verified                           | Edge propagation and active connections remain                          |
| Custom-domain preview aliases                                         | Detected as a coverage failure                                                 | Must be disabled manually; not automatically controlled                 |
| Target cron                                                           | Snapshot, replace schedule list with empty, verify                             | Propagation/running job may continue                                    |
| Queues/Workflows/DO alarms/service/email/tail/dispatch/socket callers | Settings bindings expose some gaps; mandatory manual inventory                 | Not automatically disabled; incoming references may be invisible        |
| Direct R2/S3/presigned clients and public R2 domains                  | Explicit audit requirement                                                     | Not stopped by Ferrecar WAF or Worker shutdown                          |
| Retained D1/R2 data                                                   | Preserved; current-period reserve included                                     | Storage/subscription charges continue                                   |
| Guard itself                                                          | Never a shutdown target; requests counted, overhead reserved                   | Same account/provider failure and attacks can disable or charge monitor |
| Ferrecar redeployment                                                 | Persistent latch re-verifies/repairs cutoff every minute                       | No atomic pipeline interlock; separate approval required                |

API calls have a 5-second response/body timeout, at most one retry on 429/5xx for
non-POST calls and a 256 KiB response cap. Analytics/inventory preflight has a
15-second budget for starting calls. Shutdown receives a fresh 45-second budget,
independent of preflight, and starts at most five independent actions concurrently
(three distinct zones, subdomain and cron). Calls within each action remain
sequential. A final in-flight call can take up to 10 more seconds. A slow WAF
cannot consume another action's turn. Manual cutoff skips analytics/inventory.
Recovery reads are separately bounded; long failed checks can delay a later cron
because the control object serializes requests. One GraphQL request per healthy
minute; inventory every 15 minutes or config change. Healthy state checkpoints
every 15 minutes; warnings/errors/cutoff transitions persist immediately. Latched
state reconciles each minute; there is no automatic reset.

Estimated charge line items retain their highest saved observed values within
each product's billing interval, including during recovery. Each product's floor
resets only when its verified configured interval changes. This does not make
sampled analytics exact, or recover peaks missed before a checkpoint. Malformed
durable state returns an error instead of being interpreted as unlatched; if the
scope itself is lost/corrupt the guard cannot safely mutate unknown resources.
Inventory requires a verified Workers Standard model and a readable WAF
entrypoint for each zone, and refuses malformed CPU limits or recovery settings.

## Validation status

Unit and failure-path tests are local with mocked provider responses; the Worker
bundle and local Workers runtime are checked separately. This does not validate
real API permissions, GraphQL plan limits, edge blocking/propagation, actual
Ferrecar billing, or production recovery. Record these remaining staging checks
with the customer before enabling. No production or staging deployment was made.
