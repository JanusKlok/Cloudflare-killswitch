import { api, bounded, type Api } from "./api.ts";
import {
  configuration,
  storedConfiguration,
  type Config,
  type Env,
} from "./configuration.ts";
import {
  inventory,
  enforce,
  restored,
  validateSnapshot,
  type Snapshot,
} from "./control.ts";
import { estimate, retainEstimate, validateEstimate } from "./cost.ts";
import { metrics } from "./metrics.ts";
export interface State {
  version: 1;
  latched: boolean;
  config?: Config;
  snapshot?: Snapshot;
  reason?: string;
  cutoffAt?: string;
  lastCheck?: string;
  lastGood?: string;
  lastInventory?: string;
  cost?: ReturnType<typeof estimate>;
  warning?: boolean;
  errors: string[];
  gaps: string[];
}
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export const initial = (): State => ({
  version: 1,
  latched: false,
  errors: [],
  gaps: [],
});
const controlScope = (c: Config) =>
  JSON.stringify(
    c.zones
      .map((z) => ({ id: z.id, hosts: [...z.hosts].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
export class Engine {
  constructor(
    private store: Store,
    private env: Env,
    private read: Api = api(env.ANALYTICS_TOKEN),
    private control: Api = api(env.CONTROL_TOKEN),
  ) {}
  async state(): Promise<State> {
    const s = await this.store.get<State>("state");
    if (s !== undefined) {
      if (
        !s ||
        typeof s !== "object" ||
        s.version !== 1 ||
        typeof s.latched !== "boolean" ||
        !Array.isArray(s.errors) ||
        !Array.isArray(s.gaps) ||
        [...s.errors, ...s.gaps].some((x) => typeof x !== "string")
      )
        throw Error("invalid durable state");
      if (s.config) s.config = storedConfiguration(s.config);
      if (s.cost) validateEstimate(s.cost);
      if (s.snapshot) validateSnapshot(s.snapshot);
      for (const date of [s.lastCheck, s.lastGood, s.lastInventory, s.cutoffAt])
        if (
          date !== undefined &&
          (typeof date !== "string" || !Number.isFinite(Date.parse(date)))
        )
          throw Error("invalid state timestamp");
      if (
        s.latched &&
        (!s.config?.enabled ||
          !s.snapshot ||
          !s.cutoffAt ||
          typeof s.reason !== "string")
      )
        throw Error("cutoff recovery state missing");
    }
    return s ?? initial();
  }
  async tick(now = Date.now(), manual = false): Promise<State> {
    const read = bounded(this.read, Date.now() + 15_000);
    const s = await this.state();
    let pending = Promise.resolve();
    const save = () => {
      const record = structuredClone(s);
      const write = pending.then(() => this.store.put("state", record));
      pending = write.catch(() => {});
      return write;
    };
    const shutdown = () =>
      enforce(
        bounded(this.control, Date.now() + 45_000),
        s.config!,
        s.snapshot!,
        save,
      );
    const previous = JSON.stringify(s);
    const prior = { config: s.config, cost: s.cost };
    s.lastCheck = new Date(now).toISOString();
    s.errors = [];
    // Latch precedes config parsing: disabled enforcement or expired/replaced
    // config cannot silently stop reconciliation after a guard redeployment.
    if (s.latched) {
      if (!s.config || !s.snapshot)
        throw Error("cutoff recovery state missing");
      s.errors = await shutdown();
      // Inspect drift even while shut down; unsupported new triggers stay visible.
      const live = await inventory(
        bounded(this.read, Date.now() + 15_000),
        s.config,
        true,
      );
      s.lastInventory = s.lastCheck;
      s.gaps = [
        ...live.issues,
        "Account total, ongoing storage and guard overhead remain best-effort estimates.",
      ];
      if (live.issues.length)
        s.errors.push("entrypoint/cost coverage incomplete");
      await save();
      return s;
    }
    let c: Config;
    try {
      c = configuration(this.env, now);
    } catch (e) {
      s.errors = [`configuration: ${(e as Error).message}`];
      // A previously armed, valid scope remains available for fail-closed action.
      if (s.config?.enabled) {
        s.latched = true;
        s.reason = "configuration expired or invalid";
        s.cutoffAt = s.lastCheck;
        s.snapshot ??= { routes: [], domains: [], issues: [] };
        delete s.snapshot.subdomain;
        delete s.snapshot.schedules;
        await save();
        s.errors.push(...(await shutdown()));
      }
      await save();
      return s;
    }
    const configChanged = JSON.stringify(s.config) !== JSON.stringify(c);
    s.config = c;
    if (manual && c.enabled) {
      s.latched = true;
      s.reason = "operator cutoff";
      s.cutoffAt = s.lastCheck;
      s.snapshot = {
        routes: s.snapshot?.routes ?? [],
        domains: s.snapshot?.domains ?? [],
        issues: s.snapshot?.issues ?? [],
      };
      s.gaps = [
        ...s.gaps,
        "Manual cutoff bypassed analytics/inventory; coverage will refresh on the next cron.",
      ];
      await save();
      s.errors = await shutdown();
      await save();
      return s;
    }
    // Inventory every 15 minutes; cutoff enforcement itself checks every minute.
    if (
      configChanged ||
      !s.snapshot ||
      now - Date.parse(s.lastInventory ?? "") >= 900000 ||
      !s.lastInventory ||
      manual
    ) {
      s.snapshot = await inventory(read, c);
      s.lastInventory = s.lastCheck;
    }
    s.gaps = [...s.snapshot.issues];
    try {
      const m = await metrics(read, c, now);
      s.gaps.push(...m.gaps);
      s.cost = this.estimate(m.usage, c, prior);
      s.lastGood = s.lastCheck;
      s.warning = s.cost.microUsd >= c.warning;
    } catch {
      s.errors.push(
        "metrics missing, stale, unsupported, invalid or unavailable",
      );
    }
    if (s.snapshot.issues.length)
      s.errors.push("entrypoint/cost coverage incomplete");
    const reason = manual
      ? "operator cutoff"
      : s.errors.length
        ? "monitor/coverage failure"
        : s.cost && s.cost.microUsd >= c.cutoff
          ? "estimated cutoff reached"
          : undefined;
    if (reason && c.enabled) {
      s.latched = true;
      s.reason = reason;
      s.cutoffAt = s.lastCheck;
      delete s.snapshot.subdomain;
      delete s.snapshot.schedules;
      // Durable intent is committed before ALL shutdown mutations.
      await save();
      s.errors.push(...(await shutdown()));
    } else if (reason) s.reason = `OBSERVE ONLY: would cut off (${reason})`;
    else delete s.reason;
    // One compact heartbeat every 15m while healthy; transition/errors write now.
    if (
      configChanged ||
      s.latched ||
      s.errors.length ||
      s.warning !== (JSON.parse(previous) as State).warning ||
      !previous.includes("lastCheck") ||
      now - Date.parse((JSON.parse(previous) as State).lastCheck ?? "") >=
        900000
    )
      await save();
    return s;
  }
  async rearm(confirm: string, now = Date.now()): Promise<State> {
    const s = await this.state();
    if (!s.latched || confirm !== s.cutoffAt || !s.config || !s.snapshot)
      throw Error("cutoff timestamp confirmation required");
    if (
      !(await restored(
        bounded(this.read, Date.now() + 15_000),
        s.config,
        s.snapshot,
      ))
    )
      throw Error("restore original state manually before rearming");
    const { c, live, m, cost } = await this.recovery(confirm, now);
    // No production mutation on this path. Keep original recovery evidence.
    const archive = { ...s };
    await this.store.put("previous-cutoff", archive);
    const active = {
      ...initial(),
      config: c,
      snapshot: live,
      lastCheck: new Date(now).toISOString(),
      lastGood: new Date(now).toISOString(),
      warning: false,
      lastInventory: new Date(now).toISOString(),
      cost,
      gaps: m.gaps,
    };
    await this.store.put("state", active);
    return active;
  }
  private async recovery(confirm: string, now: number) {
    const s = await this.state(),
      c = configuration(this.env, now);
    if (
      !s.latched ||
      !s.config ||
      !s.snapshot ||
      !s.cutoffAt ||
      confirm !== s.cutoffAt
    )
      throw Error("cutoff timestamp confirmation required");
    if (
      !c.enabled ||
      c.account !== s.config.account ||
      c.worker !== s.config.worker ||
      c.self !== s.config.self ||
      controlScope(c) !== controlScope(s.config)
    )
      throw Error("original scope and enabled enforcement required");
    validateSnapshot(s.snapshot);
    if (!s.snapshot.subdomain || !s.snapshot.schedules)
      throw Error("recovery snapshot incomplete");
    if (c.httpOnly && s.snapshot.schedules.length)
      throw Error("restored cron violates HTTP-only CPU policy");
    const read = bounded(this.read, Date.now() + 15_000);
    const live = await inventory(read, c, true);
    if (live.issues.length) throw Error("coverage unresolved");
    const m = await metrics(read, c, now),
      cost = this.estimate(m.usage, c, s);
    if (cost.microUsd >= c.warning)
      throw Error("cost remains at or above warning");
    return { s, c, live, m, cost };
  }
  async recoveryCheck(confirm: string, now = Date.now()) {
    const { s, m, cost } = await this.recovery(confirm, now);
    return {
      ready: true,
      cutoffAt: s.cutoffAt,
      asOf: new Date(now).toISOString(),
      cost,
      gaps: m.gaps,
    };
  }
  private estimate(
    usage: Parameters<typeof estimate>[0],
    c: Config,
    prior: Pick<State, "config" | "cost">,
  ) {
    const same = {} as Record<"workers" | "d1" | "r2", boolean>;
    for (const p of ["workers", "d1", "r2"] as const)
      same[p] =
        JSON.stringify(c.windows[p]) ===
        JSON.stringify(prior.config?.windows[p]);
    return retainEstimate(
      estimate(usage, c.fixed, c.reserve),
      prior.cost,
      same,
    );
  }
}
