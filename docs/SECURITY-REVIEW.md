# Security review — 2026-10-16

The customer requested inspection of Git hooks, test hooks and dependency supply
chains, followed by a 72-hour dependency-release rule. This records the scope
actually checked, not a claim of complete security assurance.

## Git and execution paths

- The isolated clone initially had only Git's inactive `.sample` hooks. No active
  hook or inherited `core.hooksPath` was configured. Global/system configuration
  showed the standard Git LFS filters and credential manager plus a VS Code
  editor; no custom alias, include, fsmonitor or signing execution hook was found.
  No LFS filter is selected by this repository's attributes.
- This checkout now points `core.hooksPath` at an empty sibling directory and
  disables fsmonitor locally. These are local safeguards, not global Git edits.
- The upstream package/test/workflow entrypoints were read. Upstream setup,
  install and test scripts were not run. The upstream workflow was removed on
  this feature branch; Actions were disabled in the fork before feature pushes.
- The replacement root scripts are explicit local validation commands. No root
  install, prepare, pretest or posttest hook exists. Dependency packages' own
  test/prepare commands are not recursively run by our test command.
- Tests were inspected for process spawning, shell execution, dynamic evaluation,
  environment/secret reads and remote calls. Provider calls are mocked; the one
  real network step in validation is the explicit npm metadata/signature/audit
  check. Runtime API traffic is restricted to Cloudflare's fixed HTTPS origin;
  redirects are rejected and credentials stay in headers.

## Dependencies

`.npmrc` sets `ignore-scripts=true` and exact version saving. All installs used
`--ignore-scripts`; the application has zero runtime dependencies. Development
tools are exact-pinned in `package.json` and a version-3 npm lockfile.

The first release-age gate correctly rejected three too-recent package versions
(Workers types, Wrangler, and its Miniflare dependency). An older fallback passed
the age gate but exposed known Sharp/Undici toolchain vulnerabilities and was
rejected. The selected toolchain uses **Wrangler 4.150.0** and **Workers types
5.20261006.1**, which pass both the age rule and vulnerability audit. No force
install, audit-fix override or peer-dependency bypass was used.

The final locked tree has **117 package versions**. Checked against the official
npm registry, including optional packages for other platforms:

- All publication timestamps are at least **72 hours** old.
- All tarball sources are `https://registry.npmjs.org/` with SHA-512 integrity;
  there are no linked/local/Git dependencies. Registry integrity/source metadata
  matches every locked package.
- `npm audit signatures`: **117 verified registry signatures**, **78 verified
  provenance attestations**. Packages without attestations are not represented
  as attested.
- `npm audit`: **zero known vulnerabilities** at review time.

Esbuild and workerd contain native-tool `postinstall` scripts with fallback
download/process execution paths; optional fsevents also declares an install
hook. They were inspected and left **disabled**. The matching native binaries are
supplied as locked optional npm packages. Development tools still execute their
own code when explicitly invoked; disabling lifecycle hooks is not a sandbox.

`scripts/check-supply-chain.mjs` uses Node built-ins, four bounded metadata
requests at a time and 15-second request timeouts. It fails closed for missing
metadata, packages younger than 72 hours, changed integrity/source or non-registry
dependencies. `npm run check` begins with `npm run verify-dependencies`, which
runs that gate, registry signature verification and the vulnerability audit
before typechecking/tests/build. No hidden Git or npm hook enforces it; run the
documented validation command after any lockfile change. There is no automatic
deployment or publishing step to bypass this review with.

Registry signatures and attestations identify provenance, not benign intent.
The 72-hour delay allows time for reports but cannot prevent an older malicious
release, compromised maintainer, registry compromise or previously unknown
vulnerability. No exhaustive manual review of every transitive dependency or
native binary was performed. No credentials were printed or committed.

## Follow-up correctness/security review

The same lockfile was rechecked after the final review fixes: all 117 locked
versions passed the 72-hour age, source and integrity gate. The installed-package
signature audit reported 43 verified signatures and 24 verified attestations;
zero known vulnerabilities were reported. The original 117/78 full-tree result
above is historical evidence for the unchanged lockfile, not a claim that every
package is installed on every platform. No dependency versions changed.
See [FINAL-REVIEW.md](FINAL-REVIEW.md) for the fixes and regression coverage.
