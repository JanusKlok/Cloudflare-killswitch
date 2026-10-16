import { count } from "./api.ts";
export interface Usage {
  requests: number;
  cpuMs: number;
  rowsRead: number;
  rowsWritten: number;
  d1Bytes: number;
  r2A: number;
  r2B: number;
  r2Bytes: number;
}
// Integer microdollars; BigInt intermediates avoid multiplication overflow.
const excess = (n: number, free: number) =>
  BigInt(Math.max(0, count(n) - free));
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export function estimate(u: Usage, fixed: number, reserve: number) {
  const bill = {
    fixed: BigInt(count(fixed)),
    reserve: BigInt(count(reserve)),
    requests: ceil(excess(u.requests, 10_000_000) * 300_000n, 1_000_000n),
    cpu: ceil(excess(u.cpuMs, 30_000_000) * 20_000n, 1_000_000n),
    d1Read: ceil(excess(u.rowsRead, 25_000_000_000) * 1_000n, 1_000_000n),
    d1Write: ceil(excess(u.rowsWritten, 50_000_000) * 1_000_000n, 1_000_000n),
    // Whole-period per-resource peak reserves retained storage through period end.
    // Decimal GB deliberately overcounts prices expressed in binary GB.
    d1Storage: ceil(
      excess(u.d1Bytes, 5_000_000_000) * 750_000n,
      1_000_000_000n,
    ),
    r2A: ceil(excess(u.r2A, 1_000_000), 1_000_000n) * 4_500_000n,
    r2B: ceil(excess(u.r2B, 10_000_000), 1_000_000n) * 360_000n,
    r2Storage:
      ceil(excess(u.r2Bytes, 10_000_000_000), 1_000_000_000n) * 15_000n,
  };
  const total = Object.values(bill).reduce((a, b) => a + b, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("cost overflow");
  return {
    microUsd: Number(total),
    items: Object.fromEntries(
      Object.entries(bill).map(([k, v]) => [k, Number(v)]),
    ),
    coverage:
      "Workers Standard + D1 + R2 Standard estimate with reserves; NOT account invoice total",
  };
}
const A = new Set(
  "ListBuckets PutBucket CreateBucket ListObjects ListObjectsV2 PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration".split(
    " ",
  ),
);
const B = new Set(
  "HeadBucket HeadObject GetObject UsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration".split(
    " ",
  ),
);
const FREE = new Set(
  "DeleteObject DeleteObjects DeleteBucket AbortMultipartUpload".split(" "),
);
export function r2Class(name: string): "A" | "B" | "free" {
  if (A.has(name)) return "A";
  if (B.has(name)) return "B";
  if (FREE.has(name)) return "free";
  throw Error(
    `unclassified R2 operation: ${name.replace(/[^a-zA-Z]/g, "").slice(0, 60)}`,
  );
}
export function cpuFromCeiling(requests: number, ceilingMs: number) {
  const n = BigInt(count(requests)) * BigInt(count(ceilingMs));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("CPU overflow");
  return Number(n);
}
