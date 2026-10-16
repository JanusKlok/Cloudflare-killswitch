// Built-in Node modules only. Inspect registry metadata without executing packages.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
);
const minimumHours = 72;
const now = Date.now();
const groups = new Map();
const issues = [];
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location) continue;
  if (
    !pkg.resolved?.startsWith("https://registry.npmjs.org/") ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity ?? "") ||
    pkg.link
  )
    issues.push(
      `${location}: non-registry, linked or missing SHA-512 integrity`,
    );
  const name = location.split("node_modules/").at(-1);
  if (!groups.has(name)) groups.set(name, new Set());
  groups.get(name).add(pkg.version);
}
const pending = [...groups];
const checked = [];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const [name, versions] = pending.shift();
      try {
        const r = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(name)}`,
          {
            signal: AbortSignal.timeout(15000),
            redirect: "error",
            headers: { Accept: "application/json" },
          },
        );
        if (!r.ok) throw Error(`registry HTTP ${r.status}`);
        const metadata = await r.json();
        for (const version of versions) {
          const time = Date.parse(metadata.time?.[version]);
          const ageHours = (now - time) / 3600000;
          const published = metadata.versions?.[version];
          const locked = Object.entries(lock.packages)
            .filter(
              ([p, m]) =>
                p.split("node_modules/").at(-1) === name &&
                m.version === version,
            )
            .map(([, m]) => m);
          if (!Number.isFinite(time) || ageHours < minimumHours)
            issues.push(
              `${name}@${version}: younger than ${minimumHours} hours or publication time missing`,
            );
          if (
            !published?.dist?.integrity ||
            locked.some(
              (m) =>
                m.integrity !== published.dist.integrity ||
                m.resolved !== published.dist.tarball,
            )
          )
            issues.push(
              `${name}@${version}: lock differs from registry integrity/source`,
            );
          checked.push({
            name,
            version,
            publishedAt: Number.isFinite(time)
              ? new Date(time).toISOString()
              : null,
            ageHours: Number.isFinite(time) ? Math.floor(ageHours) : null,
          });
        }
      } catch (e) {
        issues.push(`${name}: release metadata unavailable (${e.message})`);
      }
    }
  }),
);
checked.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const report = {
  checkedAt: new Date(now).toISOString(),
  minimumHours,
  lockedPackages: Object.keys(lock.packages).length - 1,
  checked,
  issues,
};
const reportPath = process.argv[2];
if (reportPath)
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  `${checked.length} package versions checked against npm registry; minimum age ${minimumHours} hours.`,
);
if (issues.length) {
  for (const issue of issues) console.error(issue);
  process.exitCode = 1;
} else console.log("Release-age, registry-source and integrity checks passed.");
