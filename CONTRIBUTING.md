# Contributing

Thanks for your interest in improving Cloudflare Kill Switch.

**This is a free, volunteer-maintained open source project provided as-is.** Issues and pull requests may sit unreviewed for extended periods or may never be addressed — there is no support commitment, roadmap, or guarantee that contributions will be merged. If you have an urgent need, fork the project and maintain your own copy.

This is also a security-sensitive tool — small bugs can mean a real outage doesn't get caught, or a kill fires when it shouldn't. The bar for changes is therefore "obviously correct, easy to reason about" rather than "clever."

## Before you open a PR

1. **Fork and clone**, then create a branch from `main`.
2. **Install dependencies** with the project's pinned pnpm settings:

   ```
   pnpm install --frozen-lockfile
   ```

   The repo enforces a 7-day quarantine on newly published packages (`minimum-release-age=10080` in `.npmrc`). If install fails with a quarantine error, the package is too new — wait or pick an older version.

3. **Verify everything passes locally**:

   ```
   pnpm typecheck
   pnpm test
   ```

   CI runs the same two commands and will block any PR that fails them.

4. **Try your change against a real Cloudflare account when feasible.** The miniflare-backed test suite catches most bugs but doesn't exercise live Cloudflare API behaviour. For non-trivial changes to `actions/`, deploy to a test account first.

## What we look for in a PR

- **Default-off changes.** If your feature changes runtime behaviour, gate it behind a config flag and default to the existing behaviour. Operators upgrading the worker should not get surprised by new actions.
- **Test coverage on the new path.** New action files need their own test file in `test/`. Use the existing `test/block-workers.test.ts` and `test/waf.test.ts` as templates.
- **Comments only where the *why* is non-obvious.** Don't restate what the code says.
- **One commit per logical change** in the PR — squash before review if you have many WIP commits.
- **No new dependencies without strong justification.** This worker has zero runtime dependencies and that's deliberate.

## Project conventions

- TypeScript `strict` + `noUncheckedIndexedAccess` — array access uses `array[i]?` patterns.
- All Cloudflare API calls go through `src/util/retry.ts`'s `fetchRetry` helper, except non-idempotent operations (Pages deployment creation) which use plain `fetch`.
- New service modules implement the `ServiceModule` interface in `src/types.ts` and register in `src/metrics/index.ts`. The orchestrator in `src/scheduled.ts` doesn't change.
- KV state is the source of truth for "are we currently killed" — never mirror it into module-scope variables.

## Reporting security issues

Please don't open a public issue for vulnerabilities. See [SECURITY.md](./SECURITY.md) for the disclosure process.

## Code of conduct

Be kind. Reviews focus on the code, not the contributor.
