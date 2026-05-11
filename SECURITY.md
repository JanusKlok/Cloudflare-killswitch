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
- Leaking secrets through logs, error messages, or email content
- Injection vulnerabilities in API calls or the email subject/body
- Denial-of-service vectors that disable monitoring (e.g. crashing the cron tick)

Out of scope:

- Vulnerabilities in Cloudflare's own services (please report those to Cloudflare directly)
- Vulnerabilities in third-party dependencies — open an issue and let dependabot handle it unless it's actively exploited
- Misconfiguration that's clearly the operator's fault (e.g. committing the `RECOVERY_SECRET` to a public repo)

## Hardening already in place

For context — these are deliberate design choices the project already makes:

- 7-day supply-chain quarantine on dependencies (`minimum-release-age=10080`)
- npm lifecycle scripts disabled by default (`ignore-scripts=true`)
- Exact version pinning, no caret/tilde ranges (`save-exact=true`)
- Constant-time comparison on the recovery secret
- Soft rate limit on `POST /restore` (10 requests / minute)
- The kill-switch worker excludes itself from `blocking.workers: 'all'` mode
- WAF rule expression exempts `POST /restore` so the recovery path stays reachable
