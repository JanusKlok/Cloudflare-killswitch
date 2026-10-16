import { rows, ApiError, type Api } from "./api.ts";
import type { Config } from "./configuration.ts";
export const REF = "ferrecar_budget_guard_v1";
export const scriptPath = (c: Config) =>
  `/accounts/${c.account}/workers/scripts/${c.worker}`;
export const expression = (hosts: string[]) =>
  `http.host in {${[...hosts]
    .sort()
    .map((h) => `"${h}"`)
    .join(" ")}}`;
interface Rule {
  id: string;
  ref?: string;
  action: string;
  expression: string;
  enabled: boolean;
}
interface Ruleset {
  id: string;
  rules: Rule[];
}
export function subdomain(value: unknown): NonNullable<Snapshot["subdomain"]> {
  const v = value as Snapshot["subdomain"];
  if (
    typeof v?.enabled !== "boolean" ||
    typeof v.previews_enabled !== "boolean"
  )
    throw Error("invalid subdomain settings");
  return { enabled: v.enabled, previews_enabled: v.previews_enabled };
}
export function schedules(value: unknown): NonNullable<Snapshot["schedules"]> {
  const parsed = rows<{ cron: string }>(value, 50).map((r) => {
    if (
      !r ||
      typeof r.cron !== "string" ||
      !r.cron.trim() ||
      r.cron.length > 256
    )
      throw Error("invalid schedules");
    return { cron: r.cron };
  });
  if (new Set(parsed.map((r) => r.cron)).size !== parsed.length)
    throw Error("duplicate schedules");
  return parsed;
}
function ruleset(value: unknown): Ruleset {
  const rs = value as Ruleset;
  if (
    !rs ||
    typeof rs.id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(rs.id) ||
    !Array.isArray(rs.rules)
  )
    throw Error("invalid ruleset");
  for (const r of rs.rules)
    if (
      !r ||
      typeof r.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(r.id) ||
      typeof r.action !== "string" ||
      typeof r.expression !== "string" ||
      typeof r.enabled !== "boolean"
    )
      throw Error("invalid rule");
  if (rs.rules.filter((r) => r.ref === REF).length > 1)
    throw Error("ambiguous guard rule");
  return rs;
}
export function validateSnapshot(s: Snapshot): void {
  if (
    !s ||
    !Array.isArray(s.routes) ||
    !Array.isArray(s.domains) ||
    !Array.isArray(s.issues) ||
    s.issues.some((x) => typeof x !== "string")
  )
    throw Error("invalid recovery snapshot");
  if (s.subdomain !== undefined) subdomain(s.subdomain);
  if (s.schedules !== undefined) schedules(s.schedules);
}
export interface Snapshot {
  subdomain?: { enabled: boolean; previews_enabled: boolean };
  schedules?: { cron: string }[];
  routes: { zone: string; id: string; pattern: string }[];
  domains: { hostname: string; zone_id: string }[];
  issues: string[];
}
export async function inventory(
  read: Api,
  c: Config,
  cutoffExpected = false,
): Promise<Snapshot> {
  const p = scriptPath(c);
  const s: Snapshot = { routes: [], domains: [], issues: [] };
  // Sequential bounded reads; failures become explicit coverage gaps.
  const attempt = async <T>(
    label: string,
    get: () => Promise<T>,
    use: (v: T) => void,
  ) => {
    try {
      use(await get());
    } catch {
      s.issues.push(`${label} unavailable or invalid`);
    }
  };
  await attempt(
    "subdomain",
    () => read<Snapshot["subdomain"]>(`${p}/subdomain`),
    (v) => {
      s.subdomain = subdomain(v);
    },
  );
  await attempt(
    "schedules",
    () => read<{ schedules: { cron: string }[] }>(`${p}/schedules`),
    (v) => {
      s.schedules = schedules(v.schedules);
    },
  );
  await attempt(
    "settings",
    () =>
      read<{
        bindings?: { type: string }[];
        limits?: { cpu_ms?: number };
        logpush?: boolean;
        tail_consumers?: unknown[];
        observability?: { enabled?: boolean };
        usage_model?: string;
      }>(`${p}/settings`),
    (v) => {
      if (!Array.isArray(v.bindings)) throw Error();
      if (v.usage_model !== "standard")
        s.issues.push("Workers Standard usage model not verified");
      const allowed = new Set([
        "plain_text",
        "secret_text",
        "d1",
        "r2_bucket",
        "assets",
      ]);
      for (const b of v.bindings)
        if (!allowed.has(b.type))
          s.issues.push(
            `unpriced/background binding: ${String(b.type).slice(0, 40)}`,
          );
      if (v.logpush || v.observability?.enabled || v.tail_consumers?.length)
        s.issues.push(
          "logs, traces or tail consumers need separate cost/entrypoint coverage",
        );
      // Below 30 minutes requires a reviewed HTTP-only deployment and observed
      // platform CPU limit (2x margin for documented runtime rollover flexibility).
      if (
        c.cpuCeilingMs < 1_800_000 &&
        (!c.httpOnly ||
          s.schedules?.length ||
          !Number.isSafeInteger(v.limits?.cpu_ms) ||
          (v.limits?.cpu_ms ?? 0) <= 0 ||
          c.cpuCeilingMs < 2 * (v.limits?.cpu_ms ?? 0))
      )
        s.issues.push(
          "CPU ceiling not established by HTTP-only inventory and platform settings",
        );
    },
  );
  await attempt(
    "domains",
    () => read<unknown>(`/accounts/${c.account}/workers/domains?per_page=100`),
    (v) => {
      const domains = rows<{
        service: string;
        hostname: string;
        zone_id: string;
        previews_enabled?: boolean;
      }>(v, 100).filter((d) => d.service === c.worker);
      if (domains.some((d) => d.previews_enabled !== false))
        s.issues.push(
          "custom-domain preview routing enabled or unknown: disable manually before enforcement",
        );
      s.domains = domains.map(({ hostname, zone_id }) => ({
        hostname,
        zone_id,
      }));
      for (const d of s.domains)
        if (
          !c.zones.some(
            (z) => z.id === d.zone_id && z.hosts.includes(d.hostname),
          )
        )
          s.issues.push("custom domain outside approved WAF scope");
    },
  );
  for (const z of c.zones) {
    await attempt(
      "WAF entrypoint",
      () =>
        read<unknown>(
          `/zones/${z.id}/rulesets/phases/http_request_firewall_custom/entrypoint`,
        ),
      (v) => {
        const rs = ruleset(v);
        if (!cutoffExpected && rs.rules.some((r) => r.ref === REF && r.enabled))
          s.issues.push(
            "guard WAF rule already active without a recorded cutoff",
          );
      },
    );
    await attempt(
      "routes",
      () => read<unknown>(`/zones/${z.id}/workers/routes`),
      (v) => {
        for (const r of rows<{ id: string; script?: string; pattern: string }>(
          v,
          100,
        ))
          if (r.script === c.worker) {
            s.routes.push({ zone: z.id, id: r.id, pattern: r.pattern });
            const host = r.pattern.replace(/^https?:\/\//, "").split("/")[0];
            if (!z.hosts.includes(host))
              s.issues.push(
                "wildcard or unlisted route hostname requires explicit coverage",
              );
          }
      },
    );
  }
  return s;
}
// Each action records its restoration snapshot BEFORE mutation. Stable WAF ref
// reconciles a successful creation whose response/state update was lost.
export async function enforce(
  control: Api,
  c: Config,
  snapshot: Snapshot,
  save: () => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];
  const p = scriptPath(c);
  const action = async (name: string, task: () => Promise<void>) => {
    try {
      await task();
    } catch {
      errors.push(`${name} failed; retry pending`);
    }
  };
  const tasks = c.zones.map((z) =>
    action(`WAF ${z.id}`, async () => {
      const base = `/zones/${z.id}/rulesets/phases/http_request_firewall_custom/entrypoint`;
      let rs = ruleset(await control(base));
      let rule = rs.rules.find((r) => r.ref === REF);
      const body = {
        ref: REF,
        action: "block",
        expression: expression(z.hosts),
        enabled: true,
        description: "Ferrecar budget guard",
      };
      if (
        rule &&
        (rule.action !== body.action ||
          rule.expression !== body.expression ||
          !rule.enabled ||
          rs.rules[0]?.ref !== REF)
      )
        await control(
          `/zones/${z.id}/rulesets/${rs.id}/rules/${rule.id}`,
          { ...body, position: { index: 1 } },
          "PATCH",
        );
      else if (!rule)
        await control(
          `/zones/${z.id}/rulesets/${rs.id}/rules`,
          { ...body, position: { index: 1 } },
          "POST",
        );
      rs = ruleset(await control(base));
      rule = rs.rules.find((r) => r.ref === REF);
      if (
        !rule ||
        !rule.enabled ||
        rule.action !== "block" ||
        rule.expression !== body.expression ||
        rs.rules[0]?.ref !== REF
      )
        throw Error();
    }),
  );
  tasks.push(
    action("workers.dev and previews", async () => {
      const v = subdomain(await control(`${p}/subdomain`));
      if (!snapshot.subdomain) {
        snapshot.subdomain = v;
        await save();
      }
      if (v.enabled || v.previews_enabled)
        await control(
          `${p}/subdomain`,
          { enabled: false, previews_enabled: false },
          "POST",
        );
      const check = subdomain(await control(`${p}/subdomain`));
      if (check.enabled !== false || check.previews_enabled !== false)
        throw Error();
    }),
  );
  tasks.push(
    action("cron schedules", async () => {
      const v = await control<{ schedules: { cron: string }[] }>(
        `${p}/schedules`,
      );
      const current = schedules(v.schedules);
      if (!snapshot.schedules) {
        snapshot.schedules = current;
        await save();
      }
      if (current.length) await control(`${p}/schedules`, [], "PUT");
      const check = await control<{ schedules: unknown[] }>(`${p}/schedules`);
      if (schedules(check.schedules).length) throw Error();
    }),
  );
  // At most five independent actions (three distinct zones + subdomain + cron).
  // A slow WAF cannot starve either application shutdown action.
  await Promise.all(tasks);
  // No D1/R2 mutation, Worker replacement/deletion, or route removal.
  return errors;
}
export async function restored(
  read: Api,
  c: Config,
  s: Snapshot,
): Promise<boolean> {
  if (!s.subdomain || !s.schedules) return false;
  validateSnapshot(s);
  const p = scriptPath(c);
  const d = subdomain(await read(`${p}/subdomain`));
  if (
    d?.enabled !== s.subdomain.enabled ||
    d?.previews_enabled !== s.subdomain.previews_enabled
  )
    return false;
  const v = await read<{ schedules: { cron: string }[] }>(`${p}/schedules`);
  if (
    JSON.stringify(
      schedules(v.schedules)
        .map((x) => x.cron)
        .sort(),
    ) !== JSON.stringify(s.schedules.map((x) => x.cron).sort())
  )
    return false;
  for (const z of c.zones) {
    let rs: Ruleset;
    try {
      rs = ruleset(
        await read(
          `/zones/${z.id}/rulesets/phases/http_request_firewall_custom/entrypoint`,
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      throw e;
    }
    if (rs.rules.some((r) => r.ref === REF && r.enabled)) return false;
  }
  return true;
}
