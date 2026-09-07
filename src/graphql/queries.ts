import type { AppConfig } from '../types.js';
import { billingPeriodStart } from '../billing.js';

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
 * UTC midnight of the day the current billing period opened — Cloudflare's
 * per-cycle quotas reset on the account's billing anniversary, not the 1st.
 */
export function cycleStart(cfg: AppConfig): string {
  return `${isoDate(billingPeriodStart(new Date(), cfg.billingCycleDay))}T00:00:00Z`;
}

// The two below are for `date_geq`/`date_leq` filters, which take a Date
// (YYYY-MM-DD) rather than a Time — a full timestamp is rejected there.

/** Current UTC calendar day. */
export function utcToday(): string {
  return isoDate(new Date());
}

/** Calendar day the current billing period opened. */
export function cycleStartDate(cfg: AppConfig): string {
  return isoDate(billingPeriodStart(new Date(), cfg.billingCycleDay));
}

/** `days` calendar days before today, inclusive of today. */
export function utcDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return isoDate(d);
}
