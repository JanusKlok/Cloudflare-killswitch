import test from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { Engine, initial, type State } from "../src/engine.ts";
import { api, ApiError, type Api } from "../src/api.ts";
import { inventory, restored } from "../src/control.ts";
import { configuration } from "../src/configuration.ts";
import { authorized, Guard } from "../src/index.ts";
import {
  NOW,
  config,
  environment,
  Memory,
  Cloud,
  analytics,
} from "./helpers.ts";

test("GraphQL nullable errors are valid; explicit failure still rejects", async () => {
  const read = api("test-only", (async () =>
    Response.json({ errors: null, data: { ok: true } })) as typeof fetch);
  assert.deepEqual(await read("/graphql", {}, "POST"), { ok: true });
  await assert.rejects(
    api("test-only", (async () =>
      Response.json({
        success: false,
        errors: null,
        data: { ok: true },
      })) as typeof fetch)("/graphql", {}, "POST"),
  );
});
test("cosmetic hostname ordering does not block recovery readiness", async () => {
  const c = config();
  c.zones[0].hosts.push("api.example.com");
  const cloud = new Cloud(),
    store = new Memory(),
    s = await new Engine(store, environment(c), cloud.call, cloud.call).tick(
      NOW,
      true,
    );
  c.zones[0].hosts.reverse();
  assert.equal(
    (
      await new Engine(
        store,
        environment(c),
        cloud.call,
        cloud.call,
      ).recoveryCheck(s.cutoffAt!, NOW)
    ).ready,
    true,
  );
});
test("manual cutoff never waits for analytics or inventory reads", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  let reads = 0;
  const read: Api = async () => {
    reads++;
    throw Error("analytics unavailable");
  };
  const s = await new Engine(store, environment(), read, cloud.call).tick(
    NOW,
    true,
  );
  assert.equal(reads, 0);
  assert.equal(s.latched, true);
  assert.equal(s.reason, "operator cutoff");
  assert.equal(cloud.sub.enabled, false);
  assert.deepEqual(cloud.schedules, []);
});
test("exhausted preflight budget does not consume the cutoff action budget", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    original = Date.now;
  let clock = original();
  Date.now = () => clock;
  const read: Api = async () => {
    clock += 60000;
    throw Error("slow read");
  };
  try {
    const s = await new Engine(store, environment(), read, cloud.call).tick(
      NOW,
    );
    assert.equal(s.latched, true);
    assert.equal(cloud.sub.enabled, false);
    assert.deepEqual(cloud.schedules, []);
  } finally {
    Date.now = original;
  }
});
test("a stalled WAF action cannot starve subdomain and cron shutdown", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  let release!: () => void,
    appMutated = false,
    observed = false;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const timer = setTimeout(release, 100);
  cloud.beforeMutation = async () => {
    appMutated = true;
    release();
  };
  const control: Api = async <T>(p: string, b?: unknown, m?: string) => {
    if (p.includes("/rulesets/") && !b && !observed) {
      await waiting;
      observed = appMutated;
    }
    return cloud.call<T>(p, b, m);
  };
  try {
    await new Engine(store, environment(), cloud.call, control).tick(NOW, true);
    assert.equal(observed, true);
    assert.equal(cloud.sub.enabled, false);
    assert.deepEqual(cloud.schedules, []);
  } finally {
    clearTimeout(timer);
    release();
  }
});
test("concurrent snapshot writes preserve originals when one write fails", async () => {
  class Faulty extends Memory {
    override async put(k: string, v: unknown) {
      if (this.writes === 1) {
        this.writes++;
        throw Error("single write failure");
      }
      return super.put(k, v);
    }
  }
  const cloud = new Cloud(),
    store = new Faulty(),
    engine = new Engine(store, environment(), cloud.call, cloud.call);
  let s = await engine.tick(NOW, true);
  assert.ok(s.errors.length);
  assert.equal(cloud.sub.enabled, true);
  s = await engine.tick(NOW + 60000);
  assert.equal(cloud.sub.enabled, false);
  assert.deepEqual(s.snapshot?.subdomain, {
    enabled: true,
    previews_enabled: true,
  });
  assert.deepEqual(s.snapshot?.schedules, [{ cron: "* * * * *" }]);
});
test("malformed original cron settings are never cleared or recorded as recoverable", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  const control: Api = async <T>(p: string, b?: unknown, m?: string) =>
    p.endsWith("/schedules") && b === undefined
      ? ({ schedules: [{}] } as T)
      : cloud.call<T>(p, b, m);
  const s = await new Engine(store, environment(), cloud.call, control).tick(
    NOW,
    true,
  );
  assert.equal(s.snapshot?.schedules, undefined);
  assert.deepEqual(cloud.schedules, [{ cron: "* * * * *" }]);
  assert.ok(s.errors.some((x) => x.includes("cron")));
  assert.ok(!cloud.mutations.some((x) => x.includes("/schedules")));
});
test("lost subdomain response and cron PUT response retry without losing the originals", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  const lost = new Set<string>();
  const control: Api = async <T>(p: string, b?: unknown, m?: string) => {
    const result = await cloud.call<T>(p, b, m);
    if (
      b !== undefined &&
      (p.endsWith("/subdomain") || p.endsWith("/schedules")) &&
      !lost.has(p)
    ) {
      lost.add(p);
      throw Error("response lost");
    }
    return result;
  };
  const engine = new Engine(store, environment(), cloud.call, control);
  let s = await engine.tick(NOW, true);
  assert.equal(s.errors.length, 2);
  s = await engine.tick(NOW + 60000);
  assert.equal(s.errors.length, 0);
  assert.equal(s.snapshot?.subdomain?.enabled, true);
  assert.equal(s.snapshot?.schedules?.length, 1);
});
test("REST envelopes need explicit true success; 403 is not retried", async () => {
  for (const success of [undefined, "false", 1])
    await assert.rejects(
      api("test-only", (async () =>
        Response.json({ success, result: [] })) as typeof fetch)("/example"),
    );
  let calls = 0;
  const read = api("test-only", (async () => {
    calls++;
    return new Response("{}", { status: 403 });
  }) as typeof fetch);
  await assert.rejects(
    read("/example"),
    (e) => e instanceof ApiError && e.status === 403,
  );
  assert.equal(calls, 1);
});
test("corrupt durable state cannot silently become an active guard", async () => {
  for (const corrupt of [
    null,
    { version: 1, latched: "false", errors: [], gaps: [] },
    { ...initial(), latched: true },
    { ...initial(), lastCheck: "invalid" },
  ]) {
    const store = new Memory(),
      cloud = new Cloud();
    store.data.set("state", corrupt);
    await assert.rejects(
      new Engine(store, environment(), cloud.call, cloud.call).tick(NOW),
    );
    assert.deepEqual(cloud.mutations, []);
  }
});
test("duplicate zone IDs and hosts cannot cause conflicting parallel WAF updates", () => {
  const c = config();
  c.zones.push(structuredClone(c.zones[0]));
  assert.throws(() => configuration(environment(c), NOW));
  c.zones.pop();
  c.zones[0].hosts.push(c.zones[0].hosts[0]);
  assert.throws(() => configuration(environment(c), NOW));
});
test("invalid CPU limits and legacy pricing models fail inventory coverage", async () => {
  const c = config(),
    cloud = new Cloud();
  c.cpuCeilingMs = 60000;
  c.httpOnly = true;
  cloud.schedules = [];
  for (const cpu of ["1", -1, NaN, Infinity]) {
    const read: Api = async <T>(p: string, b?: unknown, m?: string) =>
      p.endsWith("/settings")
        ? ({
            usage_model: "standard",
            bindings: [],
            limits: { cpu_ms: cpu },
          } as T)
        : cloud.call<T>(p, b, m);
    assert.ok(
      (await inventory(read, c)).issues.some((x) => x.includes("CPU ceiling")),
    );
  }
  const read: Api = async <T>(p: string, b?: unknown, m?: string) =>
    p.endsWith("/settings")
      ? ({
          usage_model: "unbound",
          bindings: [],
          limits: { cpu_ms: 30000 },
        } as T)
      : cloud.call<T>(p, b, m);
  assert.ok(
    (await inventory(read, c)).issues.some((x) => x.includes("usage model")),
  );
});
test("known estimated charges cannot decrease within the same billing period", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    engine = new Engine(store, environment(), cloud.call, cloud.call);
  cloud.data = analytics(128);
  const first = await engine.tick(NOW);
  cloud.data = analytics(0);
  const next = await engine.tick(NOW + 60000);
  assert.equal(next.cost?.microUsd, first.cost?.microUsd);
  assert.equal(next.warning, true);
});
test("recovery refuses a falsely low fresh estimate after a known spend cutoff", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    engine = new Engine(store, environment(), cloud.call, cloud.call);
  cloud.data = analytics(267);
  const s = await engine.tick(NOW);
  assert.equal(s.latched, true);
  cloud.data = analytics(0);
  await assert.rejects(engine.recoveryCheck(s.cutoffAt!, NOW), /cost remains/);
  cloud.sub = { enabled: true, previews_enabled: true };
  cloud.schedules = [{ cron: "* * * * *" }];
  cloud.rules = [];
  await assert.rejects(engine.rearm(s.cutoffAt!, NOW), /cost remains/);
  assert.equal((await engine.state()).latched, true);
});
test("readiness check precedes restoring traffic and does not mutate state or production", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    engine = new Engine(store, environment(), cloud.call, cloud.call),
    s = await engine.tick(NOW, true);
  const writes = store.writes,
    mutations = cloud.mutations.length;
  assert.equal((await engine.recoveryCheck(s.cutoffAt!, NOW)).ready, true);
  assert.equal(store.writes, writes);
  assert.equal(cloud.mutations.length, mutations);
  assert.equal(cloud.sub.enabled, false);
  assert.equal((await engine.state()).latched, true);
});
test("recovery requires enabled enforcement and the original control scope", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    s = await new Engine(store, environment(), cloud.call, cloud.call).tick(
      NOW,
      true,
    );
  const c = config();
  c.enabled = false;
  await assert.rejects(
    new Engine(store, environment(c), cloud.call, cloud.call).recoveryCheck(
      s.cutoffAt!,
      NOW,
    ),
    /enabled enforcement/,
  );
  c.enabled = true;
  c.zones[0].hosts = ["other.example.com"];
  await assert.rejects(
    new Engine(store, environment(c), cloud.call, cloud.call).recoveryCheck(
      s.cutoffAt!,
      NOW,
    ),
    /original scope/,
  );
  assert.equal((await store.get<State>("state"))?.latched, true);
});
test("failed archive or final rearm write leaves the cutoff latch intact", async () => {
  class Faulty extends Memory {
    failKey = "";
    override async put(k: string, v: unknown) {
      if (k === this.failKey) throw Error("recovery write failure");
      return super.put(k, v);
    }
  }
  for (const key of ["previous-cutoff", "state"]) {
    const cloud = new Cloud(),
      store = new Faulty(),
      engine = new Engine(store, environment(), cloud.call, cloud.call),
      s = await engine.tick(NOW, true);
    cloud.sub = { enabled: true, previews_enabled: true };
    cloud.schedules = [{ cron: "* * * * *" }];
    cloud.rules = [];
    store.failKey = key;
    await assert.rejects(engine.rearm(s.cutoffAt!, NOW));
    assert.equal((await engine.state()).latched, true);
    store.failKey = "";
    assert.equal((await engine.rearm(s.cutoffAt!, NOW)).latched, false);
  }
});
test("new verified billing periods permit explicit recovery but never auto-reset the latch", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  cloud.data = analytics(267);
  const s = await new Engine(store, environment(), cloud.call, cloud.call).tick(
    NOW,
  );
  const later = Date.parse("2026-11-15T18:00:00Z"),
    c = config();
  for (const p of ["workers", "d1", "r2"] as const)
    c.windows[p] = {
      start: "2026-11-10T00:00:00Z",
      end: "2026-12-10T00:00:00Z",
    };
  c.reviewedUntil = "2026-12-01T00:00:00Z";
  cloud.data = analytics(0);
  cloud.data.viewer.accounts[0].heartbeat[0].dimensions.datetime = new Date(
    later - 60000,
  ).toISOString();
  cloud.data.viewer.accounts[0].r2Recent[0].dimensions.datetime = new Date(
    later - 3600000,
  ).toISOString();
  const engine = new Engine(store, environment(c), cloud.call, cloud.call);
  assert.equal((await engine.tick(later)).latched, true);
  assert.equal((await engine.recoveryCheck(s.cutoffAt!, later)).ready, true);
  cloud.sub = { enabled: true, previews_enabled: true };
  cloud.schedules = [{ cron: "* * * * *" }];
  cloud.rules = [];
  assert.equal((await engine.rearm(s.cutoffAt!, later)).latched, false);
});
test("recovery distinguishes a missing WAF entrypoint from permission failure", async () => {
  const cloud = new Cloud(),
    snapshot = await inventory(cloud.call, config());
  for (const status of [404, 403]) {
    const read: Api = async <T>(p: string, b?: unknown, m?: string) => {
      if (p.includes("/rulesets/")) throw new ApiError(status);
      return cloud.call<T>(p, b, m);
    };
    if (status === 404)
      assert.equal(await restored(read, config(), snapshot), true);
    else await assert.rejects(restored(read, config(), snapshot));
  }
});
test("admin authentication uses equal-byte comparison and rejects short, wrong and Unicode headers", () => {
  const subtle = crypto.subtle,
    old = Object.getOwnPropertyDescriptor(subtle, "timingSafeEqual");
  Object.defineProperty(subtle, "timingSafeEqual", {
    value: timingSafeEqual,
    configurable: true,
  });
  try {
    const secret = "x".repeat(32);
    assert.equal(authorized(`Bearer ${secret}`, secret), true);
    assert.equal(authorized(`Bearer ${"y".repeat(32)}`, secret), false);
    assert.equal(authorized(`Bearer ${"é".repeat(32)}`, secret), false);
    assert.equal(authorized("Bearer short", "short"), false);
  } finally {
    if (old) Object.defineProperty(subtle, "timingSafeEqual", old);
    else Reflect.deleteProperty(subtle, "timingSafeEqual");
  }
});
test("partial cutoff returns an error status and observe mode cannot report healthy protection", async () => {
  const original = globalThis.fetch,
    cloud = new Cloud(),
    c = config();
  for (const p of ["workers", "d1", "r2"] as const)
    c.windows[p] = {
      start: new Date(Date.now() - 86400000).toISOString(),
      end: new Date(Date.now() + 86400000).toISOString(),
    };
  c.reviewedUntil = new Date(Date.now() + 86400000).toISOString();
  globalThis.fetch = (async (input: any, init: any) => {
    const p = new URL(String(input)).pathname.replace("/client/v4", "");
    if (p.endsWith("/subdomain")) return new Response("{}", { status: 403 });
    return Response.json({
      success: true,
      result: await cloud.call(
        p,
        init.body ? JSON.parse(init.body) : undefined,
        init.method,
      ),
    });
  }) as typeof fetch;
  try {
    const store = new Memory(),
      guard = new Guard(
        { storage: store } as unknown as DurableObjectState,
        environment(c),
      );
    assert.equal(
      (await guard.fetch(new Request("https://guard.internal/cutoff"))).status,
      503,
    );
    assert.equal((await store.get<State>("state"))?.latched, true);
    const observe = new Memory();
    const disabled = { ...c, enabled: false };
    await observe.put("state", {
      ...initial(),
      config: disabled,
      lastCheck: new Date().toISOString(),
    });
    const other = new Guard(
      { storage: observe } as unknown as DurableObjectState,
      environment(disabled),
    );
    assert.equal(
      (await other.fetch(new Request("https://guard.internal/status"))).status,
      503,
    );
  } finally {
    globalThis.fetch = original;
  }
});
