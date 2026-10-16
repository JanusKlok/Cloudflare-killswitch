import test from "node:test";
import assert from "node:assert/strict";
import { api, bounded } from "../src/api.ts";
const asFetch = (fn: (url: any, init: any) => Promise<Response>) =>
  fn as typeof fetch;
test("bounded transient retries and no retry of non-idempotent POST", async () => {
  let calls = 0;
  const call = api(
    "not-a-real-token",
    asFetch(async () => {
      calls++;
      return calls === 1
        ? new Response("{}", { status: 503 })
        : Response.json({ success: true, result: { ok: true } });
    }),
  );
  assert.deepEqual(await call("/example"), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(call("/example", {}, "POST"));
  assert.equal(calls, 1);
});
test("GraphQL HTTP 200 errors cannot become zero usage", async () => {
  const call = api(
    "test-only",
    asFetch(async () =>
      Response.json({
        errors: [{ message: "sensitive upstream content" }],
        data: {},
      }),
    ),
  );
  await assert.rejects(
    call("/graphql", {}, "POST"),
    (e) => !String(e).includes("sensitive"),
  );
});
test("missing, null, oversized and truncated responses fail", async () => {
  for (const j of [
    { success: true },
    { success: true, result: null },
    { result: [], result_info: { total_pages: 2 } },
  ]) {
    await assert.rejects(
      api(
        "test-only",
        asFetch(async () => Response.json(j)),
      )("/example"),
    );
  }
  await assert.rejects(
    api(
      "test-only",
      asFetch(async () => new Response(" ".repeat(262145))),
    )("/example"),
    /payload limit/,
  );
});
test("redirects forbidden, only Cloudflare API origin, credentials stay in header", async () => {
  const call = api(
    "test-only",
    asFetch(async (url, init) => {
      assert.equal(url, "https://api.cloudflare.com/client/v4/example");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer test-only");
      return Response.json({ success: true, result: [] });
    }),
  );
  await call("/example");
  await assert.rejects(call("https://evil.example/"));
  await assert.rejects(
    bounded(call, Date.now() - 1)("/example"),
    /time budget/,
  );
});
test("timeout aborts even while waiting for response", async () => {
  const call = api(
    "test-only",
    asFetch(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(Error("timeout"))),
        ),
    ),
  );
  await assert.rejects(call("/example"), /timeout/);
});
