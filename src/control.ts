import { rows, type Api } from "./api.ts";
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
export interface Snapshot {
  subdomain?: { enabled: boolean; previews_enabled: boolean };
  schedules?: { cron: string }[];
  routes: { zone: string; id: string; pattern: string }[];
  domains: { hostname: string; zone_id: string }[];
  issues: string[];
}
export async function inventory(read: Api, c: Config): Promise<Snapshot> {
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
      if (
        typeof v?.enabled !== "boolean" ||
        typeof v.previews_enabled !== "boolean"
      )
        throw Error();
      s.subdomain = v;
    },
  );
  await attempt(
    "schedules",
    () => read<{ schedules: { cron: string }[] }>(`${p}/schedules`),
    (v) => {
      s.schedules = rows<{ cron: string }>(v.schedules, 50).map((r) => {
        if (typeof r.cron !== "string") throw Error();
        return { cron: r.cron };
      });
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
      }>(`${p}/settings`),
    (v) => {
      if (!Array.isArray(v.bindings)) throw Error();
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
          !v.limits?.cpu_ms ||
          c.cpuCeilingMs < 2 * v.limits.cpu_ms)
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
  for (const z of c.zones)
    await action(`WAF ${z.id}`, async () => {
      const base = `/zones/${z.id}/rulesets/phases/http_request_firewall_custom/entrypoint`;
      let rs = await control<Ruleset>(base);
      if (!rs.id || !Array.isArray(rs.rules)) throw Error();
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
      rs = await control<Ruleset>(base);
      rule = rs.rules.find((r) => r.ref === REF);
      if (
        !rule ||
        !rule.enabled ||
        rule.action !== "block" ||
        rule.expression !== body.expression ||
        rs.rules[0]?.ref !== REF
      )
        throw Error();
    });
  await action("workers.dev and previews", async () => {
    const v = await control<NonNullable<Snapshot["subdomain"]>>(
      `${p}/subdomain`,
    );
    if (
      typeof v.enabled !== "boolean" ||
      typeof v.previews_enabled !== "boolean"
    )
      throw Error();
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
    const check = await control<NonNullable<Snapshot["subdomain"]>>(
      `${p}/subdomain`,
    );
    if (check.enabled !== false || check.previews_enabled !== false)
      throw Error();
  });
  await action("cron schedules", async () => {
    const v = await control<{ schedules: { cron: string }[] }>(
      `${p}/schedules`,
    );
    const schedules = rows<{ cron: string }>(v.schedules, 50);
    if (!snapshot.schedules) {
      snapshot.schedules = schedules.map(({ cron }) => ({ cron }));
      await save();
    }
    if (schedules.length) await control(`${p}/schedules`, [], "PUT");
    const check = await control<{ schedules: unknown[] }>(`${p}/schedules`);
    if (!Array.isArray(check.schedules) || check.schedules.length)
      throw Error();
  });
  // No D1/R2 mutation, Worker replacement/deletion, or route removal.
  return errors;
}
export async function restored(
  read: Api,
  c: Config,
  s: Snapshot,
): Promise<boolean> {
  if (!s.subdomain || !s.schedules) return false;
  const p = scriptPath(c);
  const d = await read<Snapshot["subdomain"]>(`${p}/subdomain`);
  if (
    d?.enabled !== s.subdomain.enabled ||
    d?.previews_enabled !== s.subdomain.previews_enabled
  )
    return false;
  const v = await read<{ schedules: { cron: string }[] }>(`${p}/schedules`);
  if (
    JSON.stringify(v.schedules.map((x) => x.cron).sort()) !==
    JSON.stringify(s.schedules.map((x) => x.cron).sort())
  )
    return false;
  for (const z of c.zones) {
    const rs = await read<Ruleset>(
      `/zones/${z.id}/rulesets/phases/http_request_firewall_custom/entrypoint`,
    );
    if (rs.rules.some((r) => r.ref === REF && r.enabled)) return false;
  }
  return true;
}
