import { api, bounded, type Api } from "./api.ts";
import { configuration, type Config, type Env } from "./configuration.ts";
import { inventory, enforce, restored, type Snapshot } from "./control.ts";
import { estimate } from "./cost.ts";
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
export class Engine {
  constructor(
    private store: Store,
    private env: Env,
    private read: Api = api(env.ANALYTICS_TOKEN),
    private control: Api = api(env.CONTROL_TOKEN),
  ) {}
  async state(): Promise<State> {
    const s = await this.store.get<State>("state");
    if (s && s.version !== 1)
      throw Error("state version requires operator migration");
    return s ?? initial();
  }
  async tick(now = Date.now(), manual = false): Promise<State> {
    const deadline = Date.now() + 45_000;
    const read = bounded(this.read, deadline),
      control = bounded(this.control, deadline);
    const s = await this.state();
    const save = () => this.store.put("state", s);
    const previous = JSON.stringify(s);
    s.lastCheck = new Date(now).toISOString();
    s.errors = [];
    // Latch precedes config parsing: disabled enforcement or expired/replaced
    // config cannot silently stop reconciliation after a guard redeployment.
    if (s.latched) {
      if (!s.config || !s.snapshot)
        throw Error("cutoff recovery state missing");
      s.errors = await enforce(control, s.config, s.snapshot, save);
      // Inspect drift even while shut down; unsupported new triggers stay visible.
      const live = await inventory(read, s.config);
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
        s.errors.push(...(await enforce(control, s.config, s.snapshot, save)));
      }
      await save();
      return s;
    }
    const configChanged = JSON.stringify(s.config) !== JSON.stringify(c);
    s.config = c;
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
      s.cost = estimate(m.usage, c.fixed, c.reserve);
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
      s.errors.push(...(await enforce(control, c, s.snapshot, save)));
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
    const c = configuration(this.env, now);
    if (!s.latched || confirm !== s.cutoffAt || !s.config || !s.snapshot)
      throw Error("cutoff timestamp confirmation required");
    if (
      c.account !== s.config.account ||
      c.worker !== s.config.worker ||
      c.self !== s.config.self ||
      !(await restored(this.read, s.config, s.snapshot))
    )
      throw Error("restore original state manually before rearming");
    const live = await inventory(this.read, c);
    if (live.issues.length) throw Error("coverage unresolved");
    const m = await metrics(this.read, c, now);
    const cost = estimate(m.usage, c.fixed, c.reserve);
    if (cost.microUsd >= c.warning)
      throw Error("cost remains at or above warning");
    // No production mutation on this path. Keep original recovery evidence.
    const archive = { ...s };
    await this.store.put("previous-cutoff", archive);
    const active = {
      ...initial(),
      config: c,
      snapshot: live,
      lastInventory: new Date(now).toISOString(),
      cost,
      gaps: m.gaps,
    };
    await this.store.put("state", active);
    return active;
  }
}
