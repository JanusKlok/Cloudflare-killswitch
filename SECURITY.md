# Security policy

Report vulnerabilities privately to this fork's owner through GitHub's private
security reporting when enabled. Do not post credentials, customer identifiers
or recovery snapshots publicly. Upstream issues belong with upstream only when
they also affect that project; see docs/EVIDENCE.md for the reviewed revision.

The guard has no runtime dependencies, data-purge functions or automatic restore.
It addresses only the named Ferrecar Worker and approved dedicated hostnames.
The controller credential still has account-scoped Worker write authority:
code scoping does not turn it into a per-Worker provider permission.

Use expiring, customer-owned tokens, separate analytics/controller/admin secrets,
and a separate deployment identity. Keep real configuration, secrets and recovery
snapshots untracked. Failed credentials, unavailable state, provider outages,
sampling and missing coverage can prevent cutoff. Independent monitoring and a
manual recovery plan are necessary; a same-account monitor cannot be independent.

See docs/SECURITY-REVIEW.md for hook, test entrypoint, integrity, release-age,
registry-signature/provenance and dependency audit evidence. These checks cannot
prove absence of malicious code. Review all dependency and script changes before
executing them; keep npm lifecycle scripts disabled and use the 72-hour age gate.
