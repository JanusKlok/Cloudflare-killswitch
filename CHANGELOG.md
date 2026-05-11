# Changelog

All notable changes to this project are documented here.  Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
