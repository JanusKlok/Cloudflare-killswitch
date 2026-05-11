function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * UTC midnight of the current calendar day — matches how Cloudflare counts
 * daily free-tier quotas (resets at 00:00 UTC).
 */
export function utcDayStart(): string {
  return `${isoDate(new Date())}T00:00:00Z`;
}

/** Current UTC timestamp (end of the query window). */
export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * UTC midnight of the first day of the current month — matches how Cloudflare
 * counts monthly free-tier quotas (resets on the 1st at 00:00 UTC).
 */
export function utcMonthStart(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01T00:00:00Z`;
}
