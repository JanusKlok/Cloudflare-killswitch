import type { AppConfig, Env, R2BucketRecord } from '../types.js';

export type { R2BucketRecord };
import { CfApiError, cfFetch } from '../util/cf-api.js';

// Scope: this only turns off a bucket's managed r2.dev public URL.  Buckets
// served through a connected custom domain, and any S3-API access made with R2
// API tokens, are NOT blocked here -- they are out of reach of this mechanism.

interface ManagedDomain {
  enabled?: unknown;
}

interface BucketList {
  buckets?: { name: string; jurisdiction?: string }[];
}

const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 20;
// https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/
const JURISDICTIONS = ['default', 'eu', 'us', 'fedramp', 'fedramp-high'] as const;

function bucketsPath(env: Env): string {
  return `/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/r2/buckets`;
}

function managedPath(env: Env, bucket: string): string {
  return `${bucketsPath(env)}/${encodeURIComponent(bucket)}/domains/managed`;
}

function jurisdictionHeaders(jurisdiction: string | undefined): Record<string, string> {
  return jurisdiction && jurisdiction !== 'default' ? { 'cf-r2-jurisdiction': jurisdiction } : {};
}

/** Merges freshly resolved records into already-recorded ones, existing
 *  entries winning.  After a kill a disabled bucket reads enabled:false, so
 *  re-resolving must never overwrite what was recorded before it. */
export function mergeR2Records(
  existing: readonly R2BucketRecord[],
  fresh: readonly R2BucketRecord[],
): R2BucketRecord[] {
  const known = new Set(existing.map((r) => r.bucket));
  return [...existing, ...fresh.filter((r) => !known.has(r.bucket))];
}

/** PUT of a desired state is idempotent, so retrying a transient failure is safe. */
async function setManagedDomain(env: Env, record: R2BucketRecord, enabled: boolean): Promise<void> {
  await cfFetch<unknown>(env.CLOUDFLARE_API_TOKEN, managedPath(env, record.bucket), {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
    headers: jurisdictionHeaders(record.jurisdiction),
  });
}

/** Reads one bucket's r2.dev state in a given jurisdiction.  Returns null on
 *  404 (no such bucket there), throws on any other failure. */
async function readManaged(
  env: Env,
  bucket: string,
  jurisdiction: string | undefined,
): Promise<boolean | null> {
  let state: ManagedDomain;
  try {
    state = await cfFetch<ManagedDomain>(env.CLOUDFLARE_API_TOKEN, managedPath(env, bucket), {
      headers: jurisdictionHeaders(jurisdiction),
    });
  } catch (err) {
    if (err instanceof CfApiError && err.isNotFound) return null;
    throw err;
  }
  if (typeof state?.enabled !== 'boolean') {
    throw new Error(`unexpected managed-domain response for ${bucket}`);
  }
  return state.enabled;
}

/** Returns the bucket's record if its r2.dev URL is on, null if it is off or
 *  the bucket does not exist.  A bucket named explicitly has no known
 *  jurisdiction, so each is tried in turn until one does not 404. */
async function readRecord(
  env: Env,
  bucket: string,
  knownJurisdiction: string | undefined,
): Promise<R2BucketRecord | null> {
  const candidates = knownJurisdiction === undefined ? JURISDICTIONS : [knownJurisdiction];
  for (const jurisdiction of candidates) {
    const enabled = await readManaged(env, bucket, jurisdiction);
    if (enabled === null) continue;
    if (!enabled) return null;
    return jurisdiction === 'default' ? { bucket } : { bucket, jurisdiction };
  }
  return null;
}

/** Lists every bucket in one jurisdiction.  The envelope's cursor is not
 *  exposed by cfFetch, so this pages with start_after (names sort
 *  lexicographically, per the list docs) until a short page comes back. */
async function listBuckets(
  env: Env,
  jurisdiction: string,
): Promise<{ name: string; jurisdiction: string }[]> {
  const out: { name: string; jurisdiction: string }[] = [];
  let startAfter: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const query = new URLSearchParams({ per_page: String(LIST_PAGE_SIZE) });
    if (startAfter) query.set('start_after', startAfter);
    const result = await cfFetch<BucketList>(
      env.CLOUDFLARE_API_TOKEN,
      `${bucketsPath(env)}?${query.toString()}`,
      { headers: jurisdictionHeaders(jurisdiction) },
    );
    const buckets = result?.buckets ?? [];
    for (const b of buckets)
      out.push({ name: b.name, jurisdiction: b.jurisdiction ?? jurisdiction });
    const last = buckets[buckets.length - 1];
    if (buckets.length < LIST_PAGE_SIZE || !last) break;
    startAfter = last.name;
  }
  return out;
}

/** Resolves cfg.blocking.r2 into the buckets whose r2.dev URL is currently on,
 *  without changing anything.  Only those are recorded: restoring blindly with
 *  enabled:true would make a private bucket public.
 *
 *  A failed state read still blocks the bucket (leaving a possibly-public
 *  bucket serving through a kill is bad), but the record is flagged
 *  priorStateUnknown so restore leaves it off: re-enabling could expose a
 *  private bucket, which is worse than a bucket staying dark until the operator
 *  re-enables it by hand.
 *
 *  Names in `skip` (already recorded) are dropped before any GET, so repeat
 *  resolves on later killed ticks cost nothing for known buckets. */
export async function resolveR2Targets(
  env: Env,
  cfg: AppConfig,
  skip: ReadonlySet<string> = new Set(),
): Promise<R2BucketRecord[]> {
  const r2Cfg = cfg.blocking.r2;
  if (r2Cfg === undefined || (Array.isArray(r2Cfg) && r2Cfg.length === 0)) return [];

  let candidates: { name: string; jurisdiction: string | undefined }[];
  if (Array.isArray(r2Cfg)) {
    candidates = r2Cfg.map((name) => ({ name, jurisdiction: undefined }));
  } else {
    // The list is per jurisdiction; default must succeed, the rest are best effort.
    const lists = await Promise.allSettled(JURISDICTIONS.map((j) => listBuckets(env, j)));
    const first = lists[0];
    if (first?.status === 'rejected') throw first.reason;
    candidates = [];
    lists.forEach((res, i) => {
      if (res.status === 'rejected') {
        console.error(`block-r2: could not list ${JURISDICTIONS[i] ?? '?'} buckets:`, res.reason);
        return;
      }
      for (const b of res.value) candidates.push({ name: b.name, jurisdiction: b.jurisdiction });
    });
  }

  candidates = candidates.filter((c) => !skip.has(c.name));
  const results = await Promise.allSettled(
    candidates.map((c) => readRecord(env, c.name, c.jurisdiction)),
  );
  const targets: R2BucketRecord[] = [];
  results.forEach((result, i) => {
    const cand = candidates[i];
    if (result.status === 'fulfilled') {
      if (result.value) targets.push(result.value);
      return;
    }
    console.error(
      `block-r2: could not read r2.dev state of ${cand?.name ?? '(unknown)'}:`,
      result.reason,
    );
    if (cand) {
      targets.push({
        bucket: cand.name,
        ...(cand.jurisdiction && cand.jurisdiction !== 'default'
          ? { jurisdiction: cand.jurisdiction }
          : {}),
        priorStateUnknown: true,
      });
    }
  });
  return targets;
}

/** Turns off the r2.dev URL of each recorded bucket.  Returns the records that
 *  were successfully disabled. */
export async function disableR2PublicAccess(
  env: Env,
  targets: R2BucketRecord[],
): Promise<R2BucketRecord[]> {
  if (targets.length === 0) return [];
  const results = await Promise.allSettled(targets.map((t) => setManagedDomain(env, t, false)));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`block-r2: ${targets[i]?.bucket ?? '(unknown)'} not disabled:`, result.reason);
    }
  });
  return targets.filter((_, i) => results[i]?.status === 'fulfilled');
}

/** Re-enables the r2.dev URL of each recorded bucket whose prior state is
 *  known (and only those).  `failed` are the records whose PUT failed, kept for
 *  a retry.  `skipped` are priorStateUnknown buckets, deliberately left off. */
export async function restoreR2PublicAccess(
  env: Env,
  records: R2BucketRecord[],
): Promise<{ failed: R2BucketRecord[]; skipped: R2BucketRecord[] }> {
  const skipped = records.filter((r) => r.priorStateUnknown);
  const known = records.filter((r) => !r.priorStateUnknown);
  const results = await Promise.allSettled(known.map((r) => setManagedDomain(env, r, true)));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(
        `restore-r2: ${known[i]?.bucket ?? '(unknown)'} not re-enabled:`,
        result.reason,
      );
    }
  });
  return { failed: known.filter((_, i) => results[i]?.status === 'rejected'), skipped };
}
