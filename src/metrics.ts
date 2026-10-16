import { rows, count, type Api } from "./api.ts";
import type { Config } from "./configuration.ts";
import { cpuFromCeiling, r2Class, type Usage } from "./cost.ts";
export function query(c: Config, now: number) {
  const w = c.windows;
  const iso = (s: string) => JSON.stringify(new Date(s).toISOString());
  const end = iso(new Date(now).toISOString());
  return `query { viewer { accounts(filter:{accountTag:${JSON.stringify(c.account)}}) {
    heartbeat:workersInvocationsAdaptive(limit:1,orderBy:[datetime_DESC],filter:{scriptName:${JSON.stringify(c.self)},datetime_geq:${iso(new Date(now - 15 * 60000).toISOString())},datetime_lt:${end}}) { dimensions { datetime } }
    workersInvocationsAdaptive(limit:100,filter:{datetime_geq:${iso(w.workers.start)},datetime_lt:${end}}) { sum { requests } dimensions { scriptName } }
    d1AnalyticsAdaptiveGroups(limit:2,filter:{date_geq:"${w.d1.start.slice(0, 10)}",date_leq:"${new Date(now).toISOString().slice(0, 10)}"}) { sum { rowsRead rowsWritten } }
    d1StorageAdaptiveGroups(limit:100,filter:{date_geq:"${w.d1.start.slice(0, 10)}",date_leq:"${new Date(now).toISOString().slice(0, 10)}"}) { max { databaseSizeBytes } dimensions { databaseId } }
    d1Recent:d1StorageAdaptiveGroups(limit:100,filter:{date_geq:"${new Date(now - 86400000).toISOString().slice(0, 10)}",date_leq:"${new Date(now).toISOString().slice(0, 10)}"}) { dimensions { databaseId } }
    r2OperationsAdaptiveGroups(limit:100,filter:{datetime_geq:${iso(w.r2.start)},datetime_lt:${end}}) { sum { requests } dimensions { actionType } }
    r2StorageAdaptiveGroups(limit:100,filter:{datetime_geq:${iso(w.r2.start)},datetime_lt:${end}}) { max { payloadSize metadataSize } dimensions { bucketName } }
    r2Recent:r2StorageAdaptiveGroups(limit:1,orderBy:[datetime_DESC],filter:{bucketName:${JSON.stringify(c.bucket)},datetime_geq:${iso(new Date(now - 48 * 3600000).toISOString())},datetime_lt:${end}}) { dimensions { datetime } }
  } } }`;
}
interface Worker {
  sum: { requests: number };
  dimensions: { scriptName: string };
}
export async function metrics(
  read: Api,
  c: Config,
  now: number,
): Promise<{ usage: Usage; gaps: string[] }> {
  const data = await read<{ viewer: { accounts: Record<string, unknown>[] } }>(
    "/graphql",
    { query: query(c, now) },
    "POST",
  );
  if (data.viewer?.accounts?.length !== 1)
    throw Error("missing analytics account");
  const a = data.viewer.accounts[0];
  const latest = a.heartbeat as { dimensions: { datetime: string } }[];
  const r2Latest = a.r2Recent as { dimensions: { datetime: string } }[];
  const fresh = (records: typeof latest, maxAge: number) =>
    Array.isArray(records) &&
    records.length === 1 &&
    Number.isFinite(Date.parse(records[0].dimensions?.datetime)) &&
    now - Date.parse(records[0].dimensions.datetime) >= 0 &&
    now - Date.parse(records[0].dimensions.datetime) <= maxAge;
  if (!fresh(latest, 15 * 60000) || !fresh(r2Latest, 48 * 3600000))
    throw Error("stale analytics");
  if (
    !rows<{ dimensions: { databaseId: string } }>(a.d1Recent, 100).some(
      (r) => r.dimensions.databaseId === c.d1,
    )
  )
    throw Error("stale D1 storage");
  const u: Usage = {
    requests: 0,
    cpuMs: 0,
    rowsRead: 0,
    rowsWritten: 0,
    d1Bytes: c.d1StorageFloor,
    r2A: 0,
    r2B: 0,
    r2Bytes: c.r2StorageFloor,
  };
  const gaps = [
    "Other account products, tax and subscriptions beyond configured fixed charges are not automatically covered.",
    "Adaptive analytics have ingestion delay/sampling; an HTTP success is not a freshness watermark.",
    "CPU uses a pessimistic invocation ceiling, not measured CPU; guard/DO costs use an unmeasured reserve.",
  ];
  for (const r of rows<Worker>(a.workersInvocationsAdaptive, 100)) {
    if (
      r.dimensions.scriptName !== c.self &&
      r.dimensions.scriptName !== c.worker &&
      c.cpuCeilingMs < 1_800_000
    )
      throw Error("unverified CPU ceiling for other Worker");
    u.requests += count(r.sum.requests);
    // Exclude the guard from application CPU ceiling; reserve its CPU/DO cost.
    // Its requests remain in the shared account allowance.
    if (r.dimensions.scriptName !== c.self)
      u.cpuMs += cpuFromCeiling(r.sum.requests, c.cpuCeilingMs);
  }
  for (const r of rows<{ sum: { rowsRead: number; rowsWritten: number } }>(
    a.d1AnalyticsAdaptiveGroups,
    2,
  )) {
    u.rowsRead += count(r.sum.rowsRead);
    u.rowsWritten += count(r.sum.rowsWritten);
  }
  const ds = rows<{
    max: { databaseSizeBytes: number };
    dimensions: { databaseId: string };
  }>(a.d1StorageAdaptiveGroups, 100);
  if (!ds.some((r) => r.dimensions.databaseId === c.d1))
    throw Error("missing D1 storage sample");
  u.d1Bytes = Math.max(
    u.d1Bytes,
    ds.reduce((s, r) => s + count(r.max.databaseSizeBytes), 0),
  );
  for (const r of rows<{
    sum: { requests: number };
    dimensions: { actionType: string };
  }>(a.r2OperationsAdaptiveGroups, 100)) {
    const cls = r2Class(r.dimensions.actionType);
    const n = count(r.sum.requests);
    if (cls === "A") u.r2A += n;
    if (cls === "B") u.r2B += n;
  }
  const rs = rows<{
    max: { payloadSize: number; metadataSize: number };
    dimensions: { bucketName: string };
  }>(a.r2StorageAdaptiveGroups, 100);
  if (!rs.some((r) => r.dimensions.bucketName === c.bucket))
    throw Error("missing R2 storage sample");
  u.r2Bytes = Math.max(
    u.r2Bytes,
    rs.reduce(
      (s, r) => s + count(r.max.payloadSize) + count(r.max.metadataSize),
      0,
    ),
  );
  for (const n of Object.values(u)) count(n);
  return { usage: u, gaps };
}
