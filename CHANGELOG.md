# Changelog

All notable changes to this project are documented here.  Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] — 2026-09-08

### Added

- **A "Verifying it works" section in the README.** Four ordered checks —
  config, deployment and cron trigger, a live cron tick, stored KV state — with
  a table mapping each log line to what it means, plus an optional live fire
  drill for the blocking path. The motivating problem: a Worker that cannot read
  its metrics is indistinguishable from one with nothing to report, since a
  healthy tick logs nothing at all. Includes a real (anonymised) `wrangler tail`
  capture from a healthy install, so the expected output is something you can
  compare against rather than infer — contributed from a live deploy.
- **Linting and formatting**: `pnpm lint` (oxlint with type-aware rules + a Prettier check) and `pnpm format`, both wired into CI. oxlint and Prettier were chosen over ESLint for their near-zero dependency footprint, in keeping with the project's supply-chain posture. The type-aware `no-floating-promises` / `no-misused-promises` pass found no defects, which is a useful signal for a codebase this promise-heavy.
- `test/restore.test.ts`, covering the restore path that had none. Its first case is the one every `scope: 'none'` account takes — a killed state with no WAF rule recorded — which must count as fully restored; reporting a partial failure there would make `/restore` return 502 forever and auto-reset bail, leaving the account permanently killed.
- Tests for the previously uncovered modules: `src/util/retry.ts`, `src/util/cf-api.ts`, `src/graphql/client.ts`, `src/actions/purge-d1.ts` and `src/actions/email.ts` (`test/util.test.ts`). The email deadlock above was found this way.
- `.gitattributes` normalising text files to LF and pinning `*.sh` to `eol=lf`. Without it a Windows clone with `core.autocrlf=true` gets a CRLF shebang in `setup.sh`, which fails with `bad interpreter: /usr/bin/env bash^M`.
- A **Known limitations** section in `SECURITY.md` recording the soft `/restore` rate limit, the `workers.dev`-only scope of `blocking.workers`, and the free-plan subrequest ceiling — each previously implicit.
- **`billingCycleDay` config option (1-31, default `1`).** Cloudflare invoices from the day the account was created, not the 1st, so "monthly" quotas do not reset on the 1st for most accounts. This day now anchors both the auto-reset and every per-cycle metric window (R2 Class A/B operations, and the KV/R2/D1 storage ceilings). Days 29-31 fall back to the last day of shorter months. `billingCycleDay: 1` reproduces the previous calendar-month behaviour exactly. Validated pre-deploy and prompted for by both setup scripts.
- `test/setup-scripts.test.ts` runs each of the setup scripts' `config.ts` regex anchors against the real `src/config.ts`. The scripts rewrite that file by regex, so a renamed field previously made the substitution silently no-op and drop the operator's answers.
- Pre-deploy config validation (`pnpm run validate`, run automatically by `pnpm run deploy` and the setup scripts). Cross-checks `src/config.ts` against `wrangler.toml` and reports concrete fixes: placeholder IDs, empty zone ID with `scope: 'zone'`, active `[[send_email]]` with placeholder address, `scope: 'none'` with no blocking configured, purge targets without matching bindings, `purgeAt` below `blockAt`, and the API-token permissions each configuration needs.
- The setup scripts (`setup.ps1` / `setup.sh`) now offer `scope: 'none'` and rewrite `config.ts` with regex anchors, so re-running setup works on an already-customised config.
- New `scope: 'none'` option: deploys no WAF rule and relies entirely on `blocking.workers` / `blocking.pages`. For accounts with no domain/zone (workers.dev / pages.dev only), where there is nothing for a WAF rule to attach to. Previously a failing WAF deploy (e.g. empty `CLOUDFLARE_ZONE_ID`) aborted the whole kill, so Workers/Pages were never disabled either.

### Changed

- **BREAKING — `src/config.ts` is no longer tracked.** The setup scripts rewrite
  it in place, so while it was in the repo a local setup run could be committed
  and ship one operator's choices as the project defaults — which is exactly
  what happened once (see the C2 note below). The file is now gitignored and
  seeded from a new tracked `src/config.example.ts`; setup copies the example
  before applying your answers, so re-running setup starts from the documented
  defaults instead of compounding the previous run's. Your thresholds stay out of
  the repo, a `git pull` can no longer overwrite them, and they can no longer
  reach a pull request.

  **Migration — back up your config before pulling this change.** Git deletes a
  path that a commit removes from the index, so an unmodified `src/config.ts`
  will disappear on `git pull`, and a modified one will raise a checkout
  conflict:

  ```bash
  cp src/config.ts ../config.ts.bak   # then pull, then:
  cp ../config.ts.bak src/config.ts
  ```

  Fresh clones run `cp src/config.example.ts src/config.ts` (or a setup script)
  once before `pnpm test` or `pnpm run deploy`. Change the shipped defaults by
  editing `src/config.example.ts`.
- `pnpm run validate` loads `src/config.ts` through a dynamic import behind an
  existence check, so a fresh clone gets the same actionable "copy the example"
  message it already gave for a missing `wrangler.toml` instead of a
  module-not-found stack trace.
- `test/config-defaults.test.ts` is now `test/config-example.test.ts` and pins
  the defaults in `src/config.example.ts`. It no longer fails after a local setup
  run — the file it guards is not the file setup rewrites — so the caveat about
  that in `CONTRIBUTING.md` is gone. `test/setup-scripts.test.ts` checks its
  anchors against the example for the same reason.
- R2's storage query window widened from 24h to 48h, matching KV's and D1's. If R2 snapshots less often than daily, the narrower window could return no rows and make `sumPerEntityMax` throw on every tick for any account with R2 activity; a gauge reads the same either way.
- Byte values in alert emails use binary units (`GiB`/`MiB`/`KiB`). The configured limits are binary — Cloudflare's "1 GB" KV allowance is 1,073,741,824 bytes — so dividing by 1e9 rendered the limit itself as "1.07 GB", which read like it had already been exceeded.
- The setup scripts JSON-escape every operator-supplied value they write into `src/config.ts` and `wrangler.toml`. An apostrophe in a Pages project name or a quote in an email address previously produced a file that would not parse. JSON string syntax is a subset of both TypeScript's and TOML's basic strings, so one escaper covers both.
- `setup.ps1` generates the recovery secret with `RandomNumberGenerator.Fill` instead of `RNGCryptoServiceProvider`, which is obsolete from .NET 6 (SYSLIB0023) and was never disposed. Same CSPRNG, no deprecation warning.
- `README.md` documents that `blocking.workers` covers `workers.dev` only — a Worker on a custom domain or route keeps serving unless a WAF rule covers its zone — with a table of which mechanism covers which surface. Also corrects the paid-plan subrequest ceiling from 1,000 to 10,000.
- **BREAKING (config):** `autoResetOnFirstOfMonth` is renamed `autoResetOnBillingCycle` and now pairs with `billingCycleDay`. Rename the field in `src/config.ts`; `pnpm run validate` reports an invalid or missing `billingCycleDay`.
- Auto-reset is no longer gated on the anniversary day itself. It now fires on the first tick where the kill predates the current billing period, so a Worker that was down for the whole of that day still recovers instead of waiting another full cycle.
- Per-cycle metric windows are anchored to `billingCycleDay` instead of the 1st of the calendar month. With a cycle starting on the 17th, a check on 5 February previously counted only 1-5 February and missed 17-31 January, so the switch fired after the overage had already been billed.
- `MetricSample.window` / `Breach.window` renamed their `'month'` variant to `'cycle'`, and alert emails now read `per billing cycle` rather than `(month)`.
- Dev dependencies bumped to the newest versions clearing the 7-day quarantine: @cloudflare/vitest-pool-workers 0.22.0, @cloudflare/workers-types 5.20260831.1, tsx 4.23.13, vitest 4.1.11, wrangler 4.127.1; CI uses actions/checkout@v7.
- `wrangler` 4.105.0 -> 4.127.1 and `@cloudflare/workers-types` 4.x -> 5.20260831.1, which resolves the peer mismatch the vitest-pool-workers 0.22.0 bump introduced: the pool carries a transitive wrangler that requires `workers-types@^5`, while the old pin satisfied only wrangler 4.105.0. Both typecheck configs, the lint pass and all 186 tests are clean with no source changes. Note `wrangler` has no 5.x line — this is a minor bump; the major is on the types package.
- Confirmed the `EmailMessage` shim in `src/globals.d.ts` is still required under workers-types 5: removing it fails with `TS2693` because the runtime type is still declared as a non-constructable interface.
- TypeScript 6.0.3 -> 7.0.2 (a major, 61 days old). Both typecheck configs, the lint pass and all 186 tests are clean with no source changes. Verified that the new compiler still enforces this project's strict flags rather than silently passing, by probing that it rejects a basic type mismatch, a `noUncheckedIndexedAccess` violation, and an incomplete `AppConfig` — a green typecheck immediately after a compiler major is otherwise weak evidence.
- The vitest pool now pins an explicit `compatibilityDate`. Without it the pool defaults to "today", which can exceed the newest date the installed workerd binary supports, failing every test with `ERR_RUNTIME_FAILURE`.

- Purges are now scoped to the breaching service: R2 purge targets only run on an R2 `purgeAt` breach and D1 targets only on a D1 breach. Previously a `purgeAt` breach on *any* metric (e.g. a Workers request spike) purged every configured R2 bucket and D1 table.
- `POST /restore` and the monthly auto-reset now only clear the parts of the kill that were successfully undone. On partial failure the state stays `killed` holding just the failed remnants (retryable via another `/restore`), and the webhook returns 502 with per-item errors instead of a false `restored: true`.
- The `/restore` rate limit is now keyed per client IP (`CF-Connecting-IP`) instead of globally, so an attacker spamming the endpoint can no longer lock the operator out of recovery. Rate-limit KV keys now expire automatically.
- The killed state is written immediately after the WAF rule deploys (then enriched once all actions finish), so a crash mid-kill no longer orphans the WAF rule or re-runs purges on the next tick.

### Fixed

- **The README's verification step told you to do something that cannot work.**
  It suggested triggering a tick with `curl .../__scheduled?cron=...`, which is
  a `wrangler dev` affordance only — on a deployed Worker that path returns 404
  (verified against a live deploy), so anyone following it concluded their
  install was broken. Replaced with `wrangler tail` and an explanation that a
  healthy tick logs nothing.
- The `wrangler kv key get` example used the old argument order and an
  `--namespace-id` placeholder to paste; it now uses
  `state --binding KILL_SWITCH_STATE --remote`, which reads the id from
  `wrangler.toml`. It also documented the healthy result as `null`, when current
  wrangler exits with a `404: Not Found` — now called out as normal, since the
  `state` key exists only after a kill or restore.
- The "How it works" flow still described the pre-`billingCycleDay` behaviour
  ("not the 1st of a new month"), contradicting the rest of the README.
- The testing instructions now say to copy `src/config.example.ts` first, which
  a fresh clone needs before `pnpm test`.

- **The documented API-token permissions omitted the one that gates every
  metric.** `pnpm run validate` listed only the WAF/Workers/Pages permissions
  for your scope, and the README stated outright that "the token does not need
  explicit read permissions for analytics". Both were wrong: every metric reads
  the account-scoped GraphQL Analytics API (`viewer { accounts { ... } }`),
  which requires `Account -> Account Analytics: Read`. A token built by
  following the old docs returns 403 on every query, so no breach is ever
  detected and the kill switch sits there looking deployed while doing nothing.
  The validator now always lists it first, whatever the scope, and the README
  documents it as unconditional. Found while creating a token for a real
  deploy.
- **`pnpm run validate` passed a config whose zone ID could not possibly work.** The only check on `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` and the KV namespace id was "non-empty and not containing REPLACE_ME", so a truncated paste or a stand-in word was reported as `Config check passed` — and then failed at the moment the kill fired, which is the one moment nothing may fail. With `scope: 'zone'` and a bad zone ID the WAF call fails, and with `blocking.workers`/`pages` at their empty defaults the kill switch takes no action at all. All three ids are now checked against the real Cloudflare shape (32 lowercase hex characters). Found by running the validator against a real config that had the word `none` pasted into the zone ID field.
- Test fixtures in `test/validate.test.ts` are overridden through a `withKey` helper that throws when the key is absent, instead of literal `.replace()` calls. One of those had already gone stale and was silently matching nothing, leaving its test asserting against an unmodified fixture — the same silent-no-op class as the setup-script anchors.
- **Alert emails deadlocked instead of sending.** `sendAlert` wrote the message into a `TransformStream` and awaited `writer.close()`, which does not resolve until something reads the readable end — and the only reader is the `SEND_EMAIL.send()` call on the next line, which cannot start until that await returns. The alert hung for the Worker's whole time limit, so the operator was never told the kill had fired. The message body is now built as a `ReadableStream` directly. Found by adding the first test for this module.
- Alert emails no longer risk header injection through the subject going unnoticed: the CR/LF stripping in `sanitizeHeader` now has a test proving a `\r\nBcc:` payload is flattened.
- **The `.npmrc` supply-chain quarantine was silently inert in CI.** `minimum-release-age` and `trust-policy` need pnpm >= 10.16 and `block-exotic-subdeps` needs >= 10.26, but CI pinned pnpm 9, which ignores all three without warning — and because lockfileVersion 9.0 still resolves, `--frozen-lockfile` passed and nothing complained. `SECURITY.md` advertised these as hardening already in place. pnpm is now pinned once via `packageManager` in `package.json` (read by `pnpm/action-setup`), `engines.pnpm` requires >= 10.26, and a CI step asserts each setting is actually in effect before installing.
- `actions/setup-node` bumped to v7.0.0, pinned to commit `8207627` (dated 2026-07-14, so 56 days old). Verified against the `action.yml` at that SHA rather than the release notes: `node-version` and `cache` are still declared inputs and `cache` still lists `pnpm`. The `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` env var is removed alongside it — it existed to force JS actions declared for node20 onto node24, and all three pinned actions now declare `using: node24` themselves.
- **GitHub Actions were pinned to mutable tags.** `actions/checkout@v7`, `pnpm/action-setup@v6` and `actions/setup-node@v6` are now pinned to full commit SHAs with the version in a trailing comment, and the `github-actions` Dependabot ecosystem gets the same 7-day `cooldown` the npm ecosystem already had. The workflow also declares `permissions: contents: read`.
- **`scripts/` was excluded from every typecheck.** `validate-config.ts` gates `pnpm run deploy` and `tsx` strips types without checking them, so a type error there shipped straight into the deploy path. Added `tsconfig.scripts.json`, wired into `pnpm run typecheck` and CI. The Node surface it needs is hand-declared in `scripts/node-shims.d.ts` rather than pulled from `@types/node`, whose `undici-types` dependency currently fails this project's own `trust-policy=no-downgrade` check.
- **`POST /restore` wrote to KV before authenticating.** Every request cost a KV read plus a write, and the WAF rule deliberately exempts `/restore` so it stays reachable during a kill — so unauthenticated traffic could spend the free tier's 1,000 KV writes/day, a metric this Worker monitors, and trigger the very kill it guards against. The rolling window is now checked read-only and recorded only after a *failed* authentication, capping an IP at 10 writes per window; a successful restore writes nothing to the rate limiter.
- **Storage metrics reported the period's peak rather than current usage.** KV, R2 and D1 storage took `max` across the whole month, so a bucket that peaked early and was then emptied still reported its peak — killing all traffic over data that no longer existed. Storage is a gauge, not a running total, so it is now read over a deliberately narrow recent window (2 days, or 24h for R2) that tracks the current value while still tolerating a delayed snapshot.
- **A wrong dimension or field name in a metric query failed silently.** Every module aggregates GraphQL rows by matching hardcoded strings (`actionType` values, `max.byteCount`, `max.payloadSize`, `max.databaseSizeBytes`), and the tests mocked all of these datasets as `[]` — so no row ever reached the aggregation code. A mismatch left the counter at 0, reported "no breach" forever, and kept the suite green. `test/metrics-usage.test.ts` now runs real rows through every path, including one test per service asserting that each metric name it emits maps onto a configured limit.
- A storage query returning no rows for a service that *did* report activity now throws instead of reporting 0 bytes. `runScheduled` already routes module errors to the log and the alert email without false-killing, so this surfaces rather than silently under-reads. A service with neither rows nor activity is genuinely unused and still reports 0.
- R2 operations whose `actionType` is in neither class list, and KV operations with an unrecognised `actionType`, are logged instead of being dropped from the billable total without trace. Cloudflare adds operation types over time.
- **A kill could leave Workers dark and Pages serving 503 with nothing recorded to undo it.** Blocking actions ran between two `writeKilled` calls, so an isolate death in that window left the state saying `killed` with no `disabledWorkerScripts` or `blockedPagesProjects` — the next tick no-opped and `/restore` had nothing to act on. Target discovery is now split from mutation (`resolveWorkerTargets`, `resolvePageTargets`) and the resolved targets are persisted *before* the first mutating call, so everything performed is already recorded. A Pages project's pre-kill deployment id in particular is unrecoverable once the 503 bundle is live.
- State now records the blocking *intent* rather than the outcome: re-enabling a subdomain that was never disabled is a no-op, whereas omitting one that was disabled just before a lost response left it dark permanently. The alert email reports what actually succeeded and now names the targets that failed to block.
- An unexpected throw in the cron tick is caught and logged. `ctx.waitUntil` swallows rejections, so a KV blip in `readState` previously lost the tick silently — a denial-of-service vector `SECURITY.md` lists as in scope.
- The `fetch` handler catches unexpected errors and returns a plain JSON 500 instead of letting a stack trace reach the caller. `/restore` stays reachable during a kill, so it is the most exposed surface here.
- `restoreFromState` reports an error when the killed state holds a WAF rule id without its ruleset id (or vice versa) instead of silently claiming a full restore while the rule stays live and blocks all traffic.
- **A transient Cloudflare API error could delete every WAF custom rule on the zone.** When the phase entrypoint GET failed, `deployBlockRule` fell through to `PUT .../entrypoint` with only its own rule — and PUT *replaces* a ruleset's entire rules array. The `catch` was bare, so a 403 from an expired token, a 429, or a 502 whose HTML body made `res.json()` throw all took the destructive path. The fallback now runs only on a definite HTTP 404.
- **A retried WAF rule creation could leave a permanently unliftable block.** `POST /rulesets/{id}/rules` went through `fetchRetry`, so a rule created just before a 502 was created a second time on the retry and only the second id was recorded — the first was orphaned where `/restore` could never see it, reporting success while traffic stayed blocked. Rule creation is no longer retried, and a create whose response was lost is reconciled by looking the rule up by description and adopting it.
- **A WAF failure aborted the whole kill.** `deployBlockRule` threw out of `runScheduled`, so `blocking.workers` / `blocking.pages` never ran and no state was recorded. The WAF step is now isolated: the kill proceeds with its other mitigations and the alert email says the WAF rule was not deployed.
- The WAF rule's `/restore` exemption is scoped to the new optional `RECOVERY_HOSTNAME` var. It previously matched `POST /restore` on every host in the zone, leaving that path reachable on the operator's own origin during a kill; `pnpm run validate` now warns when the webhook is on and the var is unset.
- `removeBlockRule` classifies "already deleted" from the response status and error codes instead of substring-matching the message, which also matched a rule id or timestamp that merely contained `404` or `10005`.
- Cloudflare API calls share one `src/util/cf-api.ts` helper (structured `CfApiError`, opt-out `retry`, multipart-aware `Content-Type`) instead of three near-identical private copies that had drifted apart. Per-item failures in the Workers/Pages block and restore paths are now logged individually rather than silently dropped by `Promise.allSettled`.
- **A failed auto-reset suppressed every further attempt for the rest of the period.** A partial restore rewrote the killed state with a fresh `timestamp`, which moved the auto-reset anchor into the current period — so a restore that failed on the reset day never retried, and with `enableRecoveryWebhook: false` (the shipped default) there was no manual path either. `KvState` now carries a separate `killedAt` that is preserved verbatim across rewrites, so a failed restore retries on the next tick. An unparseable kill time now fails *open* (restore, and let the next tick re-kill if usage is still over) rather than stranding the account.
- **`src/config.ts` shipped the most destructive settings while every doc claimed the opposite.** The committed defaults were `scope: 'none'`, `blocking.workers: 'all'` and `blocking.pages: 'all'`, so a clone-and-deploy would, on the first breach, disable every Worker on the account and overwrite every Pages project's production deployment — while deploying no WAF rule at all. The README and `config.ts`'s own comments documented `scope: 'zone'` with both blocking lists empty. Restored to the documented safe defaults; a new `test/config-defaults.test.ts` pins them so a local `setup.sh` run can never leak an operator's own choices into a commit again.
- Dependabot now uses a 7-day `cooldown`, matching the `.npmrc` `minimum-release-age` quarantine. Previously it proposed versions younger than 7 days, which pnpm refused to resolve, failing the updater job.

- Account-wide storage metrics for KV, R2, and D1 now group by namespace/bucket/database and sum the per-entity maxima. Previously the ungrouped `max` reported only the single largest entity, undercounting accounts with more than one namespace/bucket/database.
- GraphQL `date_geq`/`date_leq` filters (KV storage, D1 analytics and storage) are now passed calendar dates (`YYYY-MM-DD`) instead of full timestamps, which the Date filter type rejects.

- Pages blocking now deploys the 503 maintenance Worker to the project's **production branch**. Previously it deployed to a `killswitch` branch, which Cloudflare Pages treats as a preview deployment — the live site was never actually blocked.
- A failing alert email no longer prevents the killed state from being recorded. Previously an email error aborted the tick after the WAF rule was deployed, causing every subsequent tick to re-fire the kill (stacking WAF rules and re-running purges).
- The match-all WAF expression used when `enableRecoveryWebhook: false` was `(true)`, which the Cloudflare rules language rejects (no bare boolean literals) — the kill would fail entirely in that configuration. Replaced with `(ip.src ne 0.0.0.0)`.
- `POST /restore` now fails closed with 500 when `RECOVERY_SECRET` was never set. Previously the literal token `Bearer undefined` would authenticate.

## [1.0.0] — 2026-05-11

### Added

- Cron-driven monitoring of Workers, Pages, KV, R2, and D1 free-tier limits.
- WAF Custom Rule deployment on breach (zone or account scope).
- Optional Workers and Pages blocking on kill — `workers.dev` and `pages.dev` subdomains can be shut down alongside the WAF rule. Both support `'all'` for auto-discovery.
- Optional R2 bucket and D1 table purge above a configurable `purgeAt` threshold.
- Optional email alerts via Cloudflare Email Routing.
- `POST /restore` recovery webhook with shared-secret authentication.
- Auto-reset on the 1st of each UTC calendar month.
- Interactive `setup.ps1` (Windows) and `setup.sh` (macOS / Linux) setup scripts.
- 53 tests against Miniflare.
