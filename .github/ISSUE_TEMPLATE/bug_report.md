---
name: Bug report
about: Report a problem with the kill-switch worker
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- A clear description of the unexpected behaviour. -->

## What you expected

<!-- What should have happened instead. -->

## Reproduction steps

1.
2.
3.

## Logs

<!-- Output from `pnpm exec wrangler tail` and/or relevant Cloudflare dashboard screenshots. Redact secrets. -->

```
```

## Environment

- Worker version / commit:
- Cloudflare plan: free / paid
- `scope` setting: zone / account
- Optional features in use: <!-- email, R2 purge, D1 purge, blocking.workers, blocking.pages -->

## Configuration sanity check

- [ ] My API token has the permissions listed in the README for the features I'm using
- [ ] `wrangler.toml` no longer contains `REPLACE_ME_*` placeholders
- [ ] `pnpm typecheck` and `pnpm test` pass locally
