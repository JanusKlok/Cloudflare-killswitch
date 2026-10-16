import test from "node:test";
import assert from "node:assert/strict";
import { Engine, type State } from "../src/engine.ts";
import { configuration } from "../src/configuration.ts";
import { metrics, query } from "../src/metrics.ts";
import { estimate } from "../src/cost.ts";
import { inventory } from "../src/control.ts";
import {
  NOW,
  config,
  environment,
  Memory,
  Cloud,
  analytics,
} from "./helpers.ts";
test("billing windows use explicit provider boundaries, not calendar-month guess", () => {
  const c = config();
  assert.equal(
    configuration(environment(c), NOW).windows.workers.start,
    "2026-10-10T00:00:00.000Z",
  );
  assert.throws(() =>
    configuration(environment(c), Date.parse(c.windows.workers.end)),
  );
  c.windows.r2.start = "2026-09-01T00:00:00Z";
  assert.throws(() => configuration(environment(c), NOW));
});
test("leap-year and short-month exact interval boundaries", () => {
  const c = config();
  for (const k of ["workers", "d1", "r2"] as const)
    c.windows[k] = {
      start: "2028-02-29T00:00:00Z",
      end: "2028-03-29T00:00:00Z",
    };
  c.reviewedUntil = "2028-04-01T00:00:00Z";
  assert.doesNotThrow(() =>
    configuration(environment(c), Date.parse("2028-03-01T00:00:00Z")),
  );
  assert.throws(() =>
    configuration(environment(c), Date.parse("2028-03-29T00:00:00Z")),
  );
});
test("account rows include monitor requests but do not apply app CPU ceiling to guard; D1 uses rows", async () => {
  const cloud = new Cloud();
  cloud.data = analytics(100);
  const m = await metrics(cloud.call, config(), NOW);
  assert.equal(m.usage.requests, 45100);
  assert.equal(m.usage.cpuMs, 180_000_000);
  assert.equal(m.usage.rowsRead, 0);
  assert.match(query(config(), NOW), /rowsRead rowsWritten/);
  assert.doesNotMatch(query(config(), NOW), /readQueries|cpuTimeP50/);
});
test("recent canary, R2 storage and D1 presence are required; zero operations can be valid", async () => {
  for (const field of ["heartbeat", "r2Recent", "d1Recent"] as const) {
    const cloud = new Cloud();
    (cloud.data.viewer.accounts[0] as any)[field] = [];
    await assert.rejects(metrics(cloud.call, config(), NOW));
  }
  const cloud = new Cloud();
  cloud.data.viewer.accounts[0].heartbeat[0].dimensions.datetime =
    "2026-10-15T00:00:00Z";
  await assert.rejects(metrics(cloud.call, config(), NOW));
});
test("unknown operation, null and truncated analytics are errors", async () => {
  for (const bad of [
    null,
    Array(100).fill({ sum: { requests: 1 }, dimensions: { scriptName: "x" } }),
  ]) {
    const cloud = new Cloud();
    (cloud.data.viewer.accounts[0] as any).workersInvocationsAdaptive = bad;
    await assert.rejects(metrics(cloud.call, config(), NOW));
  }
  const cloud = new Cloud();
  cloud.data.viewer.accounts[0].r2OperationsAdaptiveGroups[0].dimensions.actionType =
    "FutureOperation";
  await assert.rejects(metrics(cloud.call, config(), NOW));
});
test("warning, cutoff equality and durable intent before mutation", async () => {
  const c = config(),
    store = new Memory(),
    cloud = new Cloud();
  cloud.data = analytics(128);
  const engine = new Engine(store, environment(c), cloud.call, cloud.call);
  let s = await engine.tick(NOW);
  assert.equal(s.warning, true);
  assert.equal(s.latched, false);
  cloud.data = analytics(267);
  const m = await metrics(cloud.call, c, NOW);
  c.cutoff = estimate(m.usage, c.fixed, c.reserve).microUsd;
  cloud.beforeMutation = async () => {
    assert.equal((await store.get<State>("state"))?.latched, true);
  };
  s = await new Engine(store, environment(c), cloud.call, cloud.call).tick(
    NOW + 60000,
  );
  assert.equal(s.latched, true);
  assert.equal(cloud.sub.enabled, false);
  assert.equal(cloud.sub.previews_enabled, false);
  assert.deepEqual(cloud.schedules, []);
  assert.equal(cloud.rules[0].expression, 'http.host in {"app.example.com"}');
  assert.equal(cloud.rules[0].position.index, 1);
  assert.ok(
    cloud.mutations.every(
      (x) => !x.includes(c.self) && !x.includes("/d1/") && !x.includes("/r2/"),
    ),
  );
});
test("disabled enforcement observes failure without production changes", async () => {
  const c = config();
  c.enabled = false;
  const cloud = new Cloud();
  cloud.images = true;
  const s = await new Engine(
    new Memory(),
    environment(c),
    cloud.call,
    cloud.call,
  ).tick(NOW);
  assert.equal(s.latched, false);
  assert.match(s.reason!, /OBSERVE ONLY/);
  assert.ok(s.gaps.some((x) => x.includes("images")));
  assert.deepEqual(cloud.mutations, []);
});
test("metrics failure fails closed and keeps a recoverable snapshot", async () => {
  const cloud = new Cloud();
  cloud.failed.add("/graphql");
  const s = await new Engine(
    new Memory(),
    environment(),
    cloud.call,
    cloud.call,
  ).tick(NOW);
  assert.equal(s.latched, true);
  assert.equal(s.snapshot?.subdomain?.enabled, true);
  assert.equal(s.snapshot?.schedules?.length, 1);
});
test("partial WAF failure does not prevent subdomain/cron actions and retries next tick", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  cloud.failed.add("/rulesets/");
  const e = new Engine(store, environment(), cloud.call, cloud.call);
  let s = await e.tick(NOW, true);
  assert.equal(s.latched, true);
  assert.ok(s.errors.some((x) => x.includes("WAF")));
  assert.equal(cloud.sub.enabled, false);
  assert.deepEqual(cloud.schedules, []);
  cloud.failed.clear();
  s = await e.tick(NOW + 60000);
  assert.equal(cloud.rules.length, 1);
  assert.ok(!s.errors.some((x) => x.includes("WAF")));
});
test("lost WAF creation response reconciles without duplicate; restore snapshot persists", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  cloud.lostWaf = true;
  const e = new Engine(store, environment(), cloud.call, cloud.call);
  await e.tick(NOW, true);
  assert.equal(cloud.rules.length, 1);
  const s = await e.tick(NOW + 60000);
  assert.equal(cloud.rules.length, 1);
  assert.equal(s.snapshot?.subdomain?.enabled, true);
});
test("redeployment drift is re-blocked; disabled/new billing config does not clear latch", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  await new Engine(store, environment(), cloud.call, cloud.call).tick(
    NOW,
    true,
  );
  cloud.sub.enabled = true;
  cloud.schedules = [{ cron: "0 * * * *" }];
  cloud.rules[0].enabled = false;
  const c = config();
  c.enabled = false;
  c.windows.workers.end = "2026-10-15T00:00:00Z";
  const s = await new Engine(
    store,
    environment(c),
    cloud.call,
    cloud.call,
  ).tick(NOW + 60000);
  assert.equal(s.latched, true);
  assert.equal(cloud.sub.enabled, false);
  assert.deepEqual(cloud.schedules, []);
  assert.equal(cloud.rules[0].enabled, true);
});
test("state write failure prevents all shutdown mutations", async () => {
  const store = new Memory();
  store.fail = true;
  const cloud = new Cloud();
  await assert.rejects(
    new Engine(store, environment(), cloud.call, cloud.call).tick(NOW, true),
  );
  assert.deepEqual(cloud.mutations, []);
});
test("manual recovery verifies original settings, checks costs, never activates production", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    e = new Engine(store, environment(), cloud.call, cloud.call);
  const s = await e.tick(NOW, true);
  await assert.rejects(e.rearm(s.cutoffAt!, NOW));
  cloud.sub = { enabled: true, previews_enabled: true };
  cloud.schedules = [{ cron: "* * * * *" }];
  cloud.rules = [];
  await assert.rejects(e.rearm("wrong timestamp", NOW));
  const before = cloud.mutations.length;
  const recovered = await e.rearm(s.cutoffAt!, NOW);
  assert.equal(recovered.latched, false);
  assert.equal(cloud.mutations.length, before);
  assert.ok(await store.get("previous-cutoff"));
});
test("expired configuration fails closed using previously verified scope", async () => {
  const cloud = new Cloud(),
    store = new Memory();
  await new Engine(store, environment(), cloud.call, cloud.call).tick(NOW);
  const c = config();
  c.reviewedUntil = "2026-10-15T00:00:00Z";
  const s = await new Engine(
    store,
    environment(c),
    cloud.call,
    cloud.call,
  ).tick(NOW + 60000);
  assert.equal(s.latched, true);
  assert.equal(s.reason, "configuration expired or invalid");
});
test("healthy checks checkpoint every 15 minutes, not every minute", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    e = new Engine(store, environment(), cloud.call, cloud.call);
  await e.tick(NOW);
  const first = store.writes;
  await e.tick(NOW + 60000);
  assert.equal(store.writes, first);
  // Refresh mock provider heartbeat for later check.
  cloud.data.viewer.accounts[0].heartbeat[0].dimensions.datetime = new Date(
    NOW + 14 * 60000,
  ).toISOString();
  await e.tick(NOW + 15 * 60000);
  assert.equal(store.writes, first + 1);
});
test("non-UTC billing timestamps normalize before date-granularity D1 query", () => {
  const c = config();
  c.windows.d1.start = "2026-10-09T20:00:00-04:00";
  const normalized = configuration(environment(c), NOW);
  assert.equal(normalized.windows.d1.start, "2026-10-10T00:00:00.000Z");
  assert.match(query(normalized, NOW), /date_geq:"2026-10-10"/);
});
test("custom-domain previews and wildcard route hosts remain visible coverage failures", async () => {
  const cloud = new Cloud();
  cloud.customPreviews = true;
  cloud.routePattern = "*.example.com/*";
  const snapshot = await inventory(cloud.call, config());
  assert.ok(snapshot.issues.some((x) => x.includes("preview")));
  assert.ok(snapshot.issues.some((x) => x.includes("wildcard")));
});
test("lower CPU ceiling requires observed platform limit and reviewed HTTP-only scope", async () => {
  const cloud = new Cloud(),
    c = config();
  c.cpuCeilingMs = 60000;
  assert.ok(
    (await inventory(cloud.call, c)).issues.some((x) =>
      x.includes("CPU ceiling"),
    ),
  );
  c.httpOnly = true;
  cloud.schedules = [];
  assert.ok(
    !(await inventory(cloud.call, c)).issues.some((x) =>
      x.includes("CPU ceiling"),
    ),
  );
  c.cpuCeilingMs = 59999;
  assert.ok(
    (await inventory(cloud.call, c)).issues.some((x) =>
      x.includes("CPU ceiling"),
    ),
  );
});
test("WAF rule moved behind a skip is restored to first position", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    e = new Engine(store, environment(), cloud.call, cloud.call);
  await e.tick(NOW, true);
  cloud.rules.unshift({
    id: "unrelated",
    ref: "other",
    action: "skip",
    expression: "true",
    enabled: true,
  });
  await e.tick(NOW + 60000);
  assert.equal(cloud.rules[0].ref, "ferrecar_budget_guard_v1");
  assert.equal(cloud.rules[1].id, "unrelated");
});
test("subdomain failure still blocks WAF and cron; retry captures original state", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    e = new Engine(store, environment(), cloud.call, cloud.call);
  cloud.failed.add("/subdomain");
  let s = await e.tick(NOW, true);
  assert.equal(s.snapshot?.subdomain, undefined);
  assert.equal(cloud.rules.length, 1);
  assert.deepEqual(cloud.schedules, []);
  cloud.failed.clear();
  s = await e.tick(NOW + 60000);
  assert.equal(s.snapshot?.subdomain?.enabled, true);
  assert.equal(cloud.sub.enabled, false);
});
test("recovery preserves settings that were originally disabled", async () => {
  const cloud = new Cloud(),
    store = new Memory(),
    e = new Engine(store, environment(), cloud.call, cloud.call);
  cloud.sub = { enabled: false, previews_enabled: false };
  cloud.schedules = [];
  const s = await e.tick(NOW, true);
  cloud.rules = [];
  const before = cloud.mutations.length;
  await e.rearm(s.cutoffAt!, NOW);
  assert.deepEqual(cloud.sub, { enabled: false, previews_enabled: false });
  assert.equal(cloud.mutations.length, before);
});
