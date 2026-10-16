export interface Config {
  account: string;
  worker: string;
  self: string;
  d1: string;
  bucket: string;
  enabled: boolean;
  warning: number;
  cutoff: number;
  fixed: number;
  reserve: number;
  windows: Record<"workers" | "d1" | "r2", { start: string; end: string }>;
  zones: { id: string; hosts: string[] }[];
  cpuCeilingMs: number;
  reviewedUntil: string;
  httpOnly: boolean;
  d1StorageFloor: number;
  r2StorageFloor: number;
}
export interface Env {
  CONFIG: string;
  ANALYTICS_TOKEN: string;
  CONTROL_TOKEN: string;
  ADMIN_SECRET: string;
  GUARD: DurableObjectNamespace;
}
function validate(value: unknown, now?: number): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("config shape");
  const c = value as Config;
  const keys = new Set([
    "account",
    "worker",
    "self",
    "d1",
    "bucket",
    "enabled",
    "warning",
    "cutoff",
    "fixed",
    "reserve",
    "windows",
    "zones",
    "cpuCeilingMs",
    "reviewedUntil",
    "httpOnly",
    "d1StorageFloor",
    "r2StorageFloor",
  ]);
  if (Object.keys(c).some((k) => !keys.has(k)))
    throw Error("unknown config property");
  if (
    !c.windows ||
    typeof c.windows !== "object" ||
    Object.keys(c.windows).length !== 3 ||
    Object.keys(c.windows).some((k) => !["workers", "d1", "r2"].includes(k))
  )
    throw Error("config windows");
  for (const k of ["account", "worker", "self", "d1", "bucket"] as const)
    if (
      typeof c[k] !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(c[k]) ||
      /REPLACE/.test(c[k])
    )
      throw Error(`config ${k}`);
  if (
    c.worker !== "ferrecar-platform" ||
    c.self !== "ferrecar-budget-guard" ||
    c.bucket !== "ferrecar-uploads"
  )
    throw Error("scope must be Ferrecar, excluding guard");
  if (!/^[a-f0-9]{32}$/.test(c.account)) throw Error("config account ID");
  for (const k of [
    "warning",
    "cutoff",
    "fixed",
    "reserve",
    "cpuCeilingMs",
    "d1StorageFloor",
    "r2StorageFloor",
  ] as const)
    if (!Number.isSafeInteger(c[k]) || c[k] < 0) throw Error(`config ${k}`);
  if (
    typeof c.enabled !== "boolean" ||
    typeof c.httpOnly !== "boolean" ||
    c.warning >= c.cutoff ||
    c.fixed < 5_000_000 ||
    c.reserve < 1_000_000 ||
    c.cpuCeilingMs < 1 ||
    c.cpuCeilingMs > 1_800_000
  )
    throw Error("config policy");
  if (
    !Number.isFinite(Date.parse(c.reviewedUntil)) ||
    typeof c.reviewedUntil !== "string" ||
    (now !== undefined && Date.parse(c.reviewedUntil) <= now)
  )
    throw Error("coverage review expired");
  for (const name of ["workers", "d1", "r2"] as const) {
    const w = c.windows?.[name];
    const a = Date.parse(w?.start),
      b = Date.parse(w?.end);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      typeof w?.start !== "string" ||
      typeof w?.end !== "string" ||
      Object.keys(w).length !== 2 ||
      b <= a ||
      (now !== undefined && (a > now || b <= now)) ||
      b - a > 31 * 86400000
    )
      throw Error(`billing window ${name} requires renewal`);
    c.windows[name] = {
      start: new Date(a).toISOString(),
      end: new Date(b).toISOString(),
    };
  }
  if (!Array.isArray(c.zones) || c.zones.length > 3)
    throw Error("config zones");
  const ids = new Set<string>(),
    hosts = new Set<string>();
  for (const z of c.zones) {
    if (
      !z ||
      Object.keys(z).length !== 2 ||
      !/^[a-f0-9]{32}$/.test(z.id) ||
      ids.has(z.id) ||
      !Array.isArray(z.hosts) ||
      !z.hosts.length ||
      z.hosts.length > 10 ||
      z.hosts.some(
        (h) =>
          typeof h !== "string" ||
          h.length > 253 ||
          hosts.has(h) ||
          new Set(z.hosts).size !== z.hosts.length ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ||
          h.includes("workers.dev"),
      )
    )
      throw Error("exact zone hostnames required");
    ids.add(z.id);
    for (const h of z.hosts) hosts.add(h);
  }
  return c;
}
export function configuration(env: Env, now = Date.now()): Config {
  try {
    return validate(JSON.parse(env.CONFIG), now);
  } catch {
    throw Error("invalid or expired configuration");
  }
}
// Recorded cutoff scope must remain usable after its billing/review dates expire.
export const storedConfiguration = (value: unknown) => validate(value);
