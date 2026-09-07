/** Storage is a gauge, not a running total: the free-tier limit is a ceiling on
 *  what you are holding right now, not a sum over the period.  Taking `max`
 *  across a whole billing cycle therefore reports a peak that may have been
 *  freed weeks ago, and kills on usage that no longer exists.  These helpers
 *  read a deliberately narrow recent window instead, so the value tracks
 *  current usage while still tolerating a delayed snapshot.
 */

/** Cloudflare's storage datasets are periodic snapshots, not per-request rows.
 *  Two days (or 24h) is wide enough to survive a late snapshot and narrow
 *  enough that the max within it is effectively the current value. */
export const STORAGE_WINDOW_DAYS = 2;
export const STORAGE_WINDOW_HOURS = 24;

/** Sums the per-entity maximum across `rows`.
 *
 *  The limits these feed are account-wide, so an ungrouped `max` would report
 *  only the single largest namespace/bucket/database.  Grouping and summing the
 *  per-entity maxima gives the account total.
 *
 *  Throws when the window returned no rows *but* the service saw activity:
 *  reporting 0 there would silently mean "no breach" forever, which is the
 *  failure mode this whole module exists to avoid.  A service with no activity
 *  and no rows is genuinely unused, so it reports 0.
 */
export function sumPerEntityMax<T>(
  service: string,
  field: string,
  rows: T[],
  keyOf: (row: T) => string,
  valueOf: (row: T) => number,
  serviceHasActivity: boolean,
): number {
  if (rows.length === 0) {
    if (serviceHasActivity) {
      throw new Error(
        `${service}: ${field} returned no rows while the service reported activity — treating storage as unknown rather than 0`,
      );
    }
    return 0;
  }

  const perEntityMax = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    const value = valueOf(row);
    if (!Number.isFinite(value)) {
      throw new Error(`${service}: ${field} for "${key}" was not a finite number`);
    }
    perEntityMax.set(key, Math.max(perEntityMax.get(key) ?? 0, value));
  }

  let total = 0;
  for (const value of perEntityMax.values()) total += value;
  return total;
}
