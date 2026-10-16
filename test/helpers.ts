import type { Config, Env } from "../src/configuration.ts";
import type { Api } from "../src/api.ts";
import type { Store } from "../src/engine.ts";
export const NOW = Date.parse("2026-10-16T18:00:00Z");
export const config = (): Config => ({
  account: "a".repeat(32),
  worker: "ferrecar-platform",
  self: "ferrecar-budget-guard",
  d1: "test-database-id",
  bucket: "ferrecar-uploads",
  enabled: true,
  warning: 10_000_000,
  cutoff: 15_000_000,
  fixed: 5_000_000,
  reserve: 1_000_000,
  windows: {
    workers: { start: "2026-10-10T00:00:00Z", end: "2026-11-10T00:00:00Z" },
    d1: { start: "2026-10-10T00:00:00Z", end: "2026-11-10T00:00:00Z" },
    r2: { start: "2026-10-10T00:00:00Z", end: "2026-11-10T00:00:00Z" },
  },
  zones: [{ id: "b".repeat(32), hosts: ["app.example.com"] }],
  cpuCeilingMs: 1_800_000,
  reviewedUntil: "2026-11-01T00:00:00Z",
  httpOnly: false,
  d1StorageFloor: 0,
  r2StorageFloor: 0,
});
export const environment = (c = config()) =>
  ({
    CONFIG: JSON.stringify(c),
    ANALYTICS_TOKEN: "test-only",
    CONTROL_TOKEN: "test-only",
    ADMIN_SECRET: "test-only",
  }) as Env;
export class Memory implements Store {
  data = new Map<string, unknown>();
  writes = 0;
  fail = false;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    if (this.fail) throw Error("storage unavailable");
    this.writes++;
    this.data.set(key, structuredClone(value));
  }
}
export function analytics(n = 0) {
  return {
    viewer: {
      accounts: [
        {
          heartbeat: [
            { dimensions: { datetime: new Date(NOW - 60000).toISOString() } },
          ],
          workersInvocationsAdaptive: [
            {
              sum: { requests: n },
              dimensions: { scriptName: "ferrecar-platform" },
            },
            {
              sum: { requests: 45000 },
              dimensions: { scriptName: "ferrecar-budget-guard" },
            },
          ],
          d1AnalyticsAdaptiveGroups: [
            { sum: { rowsRead: 0, rowsWritten: 0, readQueries: 999999999999 } },
          ],
          d1StorageAdaptiveGroups: [
            {
              max: { databaseSizeBytes: 1024 },
              dimensions: { databaseId: "test-database-id" },
            },
          ],
          d1Recent: [{ dimensions: { databaseId: "test-database-id" } }],
          r2OperationsAdaptiveGroups: [
            { sum: { requests: 0 }, dimensions: { actionType: "GetObject" } },
          ],
          r2StorageAdaptiveGroups: [
            {
              max: { payloadSize: 1024, metadataSize: 0 },
              dimensions: { bucketName: "ferrecar-uploads" },
            },
          ],
          r2Recent: [
            { dimensions: { datetime: new Date(NOW - 3600000).toISOString() } },
          ],
        },
      ],
    },
  };
}
export class Cloud {
  data = analytics();
  sub = { enabled: true, previews_enabled: true };
  schedules = [{ cron: "* * * * *" }];
  rules: any[] = [];
  mutations: string[] = [];
  failed = new Set<string>();
  lostWaf = false;
  images = false;
  customPreviews = false;
  routePattern = "app.example.com/*";
  beforeMutation?: () => Promise<void>;
  call: Api = async <T>(p: string, body?: any, method?: string): Promise<T> => {
    const mutation = body !== undefined && p !== "/graphql";
    if (mutation) {
      await this.beforeMutation?.();
      this.mutations.push(`${method ?? "PUT"} ${p}`);
    }
    if ([...this.failed].some((x) => p.includes(x)))
      throw Error("mock provider failure");
    let value: unknown;
    if (p === "/graphql") value = this.data;
    else if (p.includes("/rulesets/")) {
      if (body) {
        const existing = this.rules.find((r) => r.ref === body.ref);
        if (existing) {
          Object.assign(existing, body);
          if (body.position?.index === 1)
            this.rules = [
              existing,
              ...this.rules.filter((r) => r !== existing),
            ];
        } else this.rules.push({ ...body, id: "rule-1" });
        if (this.lostWaf) {
          this.lostWaf = false;
          throw Error("response lost");
        }
      }
      value = { id: "rs-1", rules: this.rules };
    } else if (p.endsWith("/subdomain")) {
      if (body) this.sub = { ...body };
      value = this.sub;
    } else if (p.endsWith("/schedules")) {
      if (body) this.schedules = structuredClone(body);
      value = { schedules: this.schedules };
    } else if (p.endsWith("/settings"))
      value = {
        usage_model: "standard",
        bindings: [
          { type: "d1" },
          { type: this.images ? "images" : "r2_bucket" },
        ],
        limits: { cpu_ms: 30000 },
      };
    else if (p.includes("/workers/domains"))
      value = [
        {
          service: "ferrecar-platform",
          hostname: "app.example.com",
          zone_id: "b".repeat(32),
          previews_enabled: this.customPreviews,
        },
      ];
    else if (p.endsWith("/workers/routes"))
      value = [
        {
          id: "route-1",
          script: "ferrecar-platform",
          pattern: this.routePattern,
        },
      ];
    else throw Error(`unexpected API ${p}`);
    return structuredClone(value) as T;
  };
}
