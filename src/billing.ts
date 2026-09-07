// Cloudflare's invoicing period runs from the day of the month the account was
// created, not from the 1st, so anything that resets "monthly" has to be
// anchored to a configurable day. `billingCycleDay: 1` reproduces plain
// calendar-month behaviour exactly.

export const MIN_BILLING_CYCLE_DAY = 1;
export const MAX_BILLING_CYCLE_DAY = 31;

export function isValidBillingCycleDay(day: number): boolean {
  return Number.isInteger(day) && day >= MIN_BILLING_CYCLE_DAY && day <= MAX_BILLING_CYCLE_DAY;
}

/** Day 29-31 has no counterpart in every month, so the cycle falls back to that
 *  month's last day — a 31st cycle opens on Feb 28, or Feb 29 in a leap year. */
function effectiveDay(year: number, month: number, day: number): number {
  // Day 0 of the following month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, daysInMonth);
}

/** UTC midnight of the day the billing period containing `at` opened. */
export function billingPeriodStart(at: Date, billingCycleDay: number): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const anniversary = effectiveDay(year, month, billingCycleDay);

  if (at.getUTCDate() >= anniversary) {
    return new Date(Date.UTC(year, month, anniversary));
  }

  // Before this month's anniversary — the period opened in the previous month.
  // Date.UTC normalises month -1 into December of the preceding year.
  const prev = new Date(Date.UTC(year, month - 1, 1));
  const prevYear = prev.getUTCFullYear();
  const prevMonth = prev.getUTCMonth();
  return new Date(
    Date.UTC(prevYear, prevMonth, effectiveDay(prevYear, prevMonth, billingCycleDay)),
  );
}
