import test from "node:test";
import assert from "node:assert/strict";
import { estimate, r2Class, cpuFromCeiling, type Usage } from "../src/cost.ts";
const zero: Usage = {
  requests: 0,
  cpuMs: 0,
  rowsRead: 0,
  rowsWritten: 0,
  d1Bytes: 0,
  r2A: 0,
  r2B: 0,
  r2Bytes: 0,
};
test("official Workers 15M requests at 7ms example is $8 incl $5 subscription", () => {
  const e = estimate(
    { ...zero, requests: 15_000_000, cpuMs: cpuFromCeiling(15_000_000, 7) },
    5_000_000,
    0,
  );
  assert.equal(e.microUsd, 8_000_000);
  assert.equal(e.items.cpu, 1_500_000);
});
test("CPU milliseconds not microseconds or seconds; fractions round upward", () => {
  assert.equal(cpuFromCeiling(1000, 1000), 1_000_000);
  assert.equal(cpuFromCeiling(1.1, 2), 4);
  assert.equal(
    estimate({ ...zero, cpuMs: 31_000_000 }, 0, 0).items.cpu,
    20_000,
  );
});
test("shared account allowances applied once across resources", () => {
  const e = estimate(
    {
      ...zero,
      requests: 8_000_000 + 8_000_000,
      rowsRead: 25_001_000_000,
      rowsWritten: 51_000_000,
    },
    0,
    0,
  );
  assert.equal(e.items.requests, 1_800_000);
  assert.equal(e.items.d1Read, 1000);
  assert.equal(e.items.d1Write, 1_000_000);
});
test("R2 listing is A, reads B, deletes free; unknown names fail closed", () => {
  for (const n of [
    "ListObjects",
    "ListObjectsV2",
    "ListBuckets",
    "ListParts",
    "ListMultipartUploads",
  ])
    assert.equal(r2Class(n), "A");
  assert.equal(r2Class("GetObject"), "B");
  for (const n of ["DeleteObject", "DeleteBucket", "AbortMultipartUpload"])
    assert.equal(r2Class(n), "free");
  assert.throws(() => r2Class("NewUnpricedOperation"));
});
test("R2 rounds whole million operations and whole GB after shared free tier", () => {
  const e = estimate(
    { ...zero, r2A: 1_000_001, r2B: 10_000_001, r2Bytes: 10_000_000_001 },
    0,
    0,
  );
  assert.equal(e.items.r2A, 4_500_000);
  assert.equal(e.items.r2B, 360_000);
  assert.equal(e.items.r2Storage, 15_000);
  assert.equal(
    estimate({ ...zero, r2A: 2_000_001 }, 0, 0).items.r2A,
    9_000_000,
  );
});
test("full-period retained storage, fixed subscription and guard reserve survive cutoff", () => {
  const e = estimate(
    { ...zero, d1Bytes: 6_000_000_000, r2Bytes: 11_000_000_000 },
    5_000_000,
    1_000_000,
  );
  assert.equal(e.microUsd, 6_765_000);
  assert.match(e.coverage, /NOT account/);
});
test("bad numbers and multiplication overflow rejected", () => {
  for (const n of [NaN, Infinity, -1])
    assert.throws(() => estimate({ ...zero, rowsRead: n }, 0, 0));
  assert.throws(() => cpuFromCeiling(Number.MAX_SAFE_INTEGER, 2));
});
