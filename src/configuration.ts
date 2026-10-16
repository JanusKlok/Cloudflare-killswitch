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
export function configuration(env: Env, now = Date.now()): Config {
  const c: Config = JSON.parse(env.CONFIG);
  for (const k of ["account", "worker", "self", "d1", "bucket"] as const)
    if (
      typeof c[k] !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(c[k]) ||
      /REPLACE/.test(c[k])
    )
      throw Error(`config ${k}`);
  if (
    c.worker !== "ferrecar-platform" ||
    c.self === c.worker ||
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
    Date.parse(c.reviewedUntil) <= now
  )
    throw Error("coverage review expired");
  for (const name of ["workers", "d1", "r2"] as const) {
    const w = c.windows?.[name];
    const a = Date.parse(w?.start),
      b = Date.parse(w?.end);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a > now ||
      b <= now ||
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
  for (const z of c.zones)
    if (
      !/^[a-f0-9]{32}$/.test(z.id) ||
      !z.hosts.length ||
      z.hosts.length > 10 ||
      z.hosts.some(
        (h) =>
          !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ||
          h.includes("..") ||
          h.includes("workers.dev"),
      )
    )
      throw Error("exact zone hostnames required");
  return c;
}
