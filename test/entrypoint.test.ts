import test from "node:test";
import assert from "node:assert/strict";
import worker, { Guard } from "../src/index.ts";
import { Memory, Cloud, environment, config } from "./helpers.ts";
test("unauthenticated or unsupported admin requests cannot reach control object", async () => {
  const env = environment();
  env.GUARD = {
    idFromName: () => {
      throw Error("must not route");
    },
  } as unknown as DurableObjectNamespace;
  assert.equal(
    (await worker.fetch(new Request("https://guard.example/status"), env))
      .status,
    404,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://guard.example/rearm", {
          headers: { Authorization: "Bearer test-only" },
        }),
        env,
      )
    ).status,
    404,
  );
});
test("control object serializes requests while waiting for provider network I/O", async () => {
  const original = globalThis.fetch;
  const cloud = new Cloud(),
    store = new Memory();
  const c = config();
  for (const name of ["workers", "d1", "r2"] as const)
    c.windows[name] = {
      start: new Date(Date.now() - 86400000).toISOString(),
      end: new Date(Date.now() + 86400000).toISOString(),
    };
  c.reviewedUntil = new Date(Date.now() + 86400000).toISOString();
  cloud.data.viewer.accounts[0].heartbeat[0].dimensions.datetime = new Date(
    Date.now() - 60000,
  ).toISOString();
  cloud.data.viewer.accounts[0].r2Recent[0].dimensions.datetime = new Date(
    Date.now() - 3600000,
  ).toISOString();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const start = new Promise<void>((r) => {
    entered = r;
  });
  globalThis.fetch = (async (input: any, init: any) => {
    const p =
      new URL(String(input)).pathname.replace("/client/v4", "") +
      new URL(String(input)).search;
    if (p === "/graphql") {
      entered();
      await waiting;
      return Response.json({ data: cloud.data });
    }
    const result = await cloud.call(
      p,
      init.body ? JSON.parse(init.body) : undefined,
      init.method,
    );
    return Response.json({ success: true, result });
  }) as typeof fetch;
  try {
    const guard = new Guard(
      { storage: store } as unknown as DurableObjectState,
      environment(c),
    );
    const first = guard.fetch(new Request("https://guard.internal/tick"));
    await start;
    let statusDone = false;
    const second = guard
      .fetch(new Request("https://guard.internal/status"))
      .then((r) => {
        statusDone = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(statusDone, false);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally {
    release();
    globalThis.fetch = original;
  }
});
