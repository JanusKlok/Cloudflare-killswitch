# Changelog

All notable changes to this project are documented here.  Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Pre-deploy config validation (`pnpm run validate`, run automatically by `pnpm run deploy` and the setup scripts). Cross-checks `src/config.ts` against `wrangler.toml` and reports concrete fixes: placeholder IDs, empty zone ID with `scope: 'zone'`, active `[[send_email]]` with placeholder address, `scope: 'none'` with no blocking configured, purge targets without matching bindings, `purgeAt` below `blockAt`, and the API-token permissions each configuration needs.
- The setup scripts (`setup.ps1` / `setup.sh`) now offer `scope: 'none'` and rewrite `config.ts` with regex anchors, so re-running setup works on an already-customised config.
- New `scope: 'none'` option: deploys no WAF rule and relies entirely on `blocking.workers` / `blocking.pages`. For accounts with no domain/zone (workers.dev / pages.dev only), where there is nothing for a WAF rule to attach to. Previously a failing WAF deploy (e.g. empty `CLOUDFLARE_ZONE_ID`) aborted the whole kill, so Workers/Pages were never disabled either.

### Changed

- Purges are now scoped to the breaching service: R2 purge targets only run on an R2 `purgeAt` breach and D1 targets only on a D1 breach. Previously a `purgeAt` breach on *any* metric (e.g. a Workers request spike) purged every configured R2 bucket and D1 table.
- `POST /restore` and the monthly auto-reset now only clear the parts of the kill that were successfully undone. On partial failure the state stays `killed` holding just the failed remnants (retryable via another `/restore`), and the webhook returns 502 with per-item errors instead of a false `restored: true`.
- The `/restore` rate limit is now keyed per client IP (`CF-Connecting-IP`) instead of globally, so an attacker spamming the endpoint can no longer lock the operator out of recovery. Rate-limit KV keys now expire automatically.
- The killed state is written immediately after the WAF rule deploys (then enriched once all actions finish), so a crash mid-kill no longer orphans the WAF rule or re-runs purges on the next tick.

### Fixed

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
