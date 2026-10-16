# Contributing to this fork

Keep the scope limited to Ferrecar and retain the upstream MIT attribution.
No runtime dependencies, data deletion, production auto-restore, deployment
workflow or changes to the Ferrecar application belong in this branch.

Use Node 22+, npm ci --ignore-scripts, npm run verify-dependencies and npm run check.
The 72-hour release-age rule covers every package in the lockfile. Missing
registry metadata or integrity mismatch must fail validation. Review root scripts,
Git hooks and dependency install scripts before running changed tooling. No Git
hook is required or installed by this repository. Dependencies' own test scripts
are not invoked by this repository's test command.

Tests should cover real cost/safety invariants and provider failure paths. Update
the Unreleased changelog and coverage/operations documentation for behavior
changes. Test edge propagation and actual API schema/permissions in a disposable
customer account before proposing deployment. Opening a PR, deploying and merging
are separate operator actions.
