import type { Env } from './types.js';
import { sendAlert } from './actions/email.js';
import { sendWebhook } from './actions/webhook.js';

const METRIC_FAILURE_ALERT_KEY = 'metric-failure-alert-day';

/** Send an alert on every configured channel (email, webhook) concurrently.
 *  One channel failing never blocks another and this never throws. */
export async function sendAlerts(env: Env, subject: string, body: string): Promise<void> {
  const channels = [
    ['email', sendAlert],
    ['webhook', sendWebhook],
  ] as const;
  const results = await Promise.allSettled(
    channels.map(async ([, send]) => send(env, subject, body)),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`${channels[i]?.[0] ?? 'alert'} alert failed: ${msg}`);
    }
  });
}

/**
 * True at most once per UTC day, for "metric fetch keeps failing" alerts.
 * KV is written only when this returns true: the Free plan allows 1,000 KV
 * writes/day and this Worker is itself monitoring that metric, so a failing
 * tick must not burn writes every 5 minutes.
 */
export async function shouldAlertMetricFailure(env: Env, now: Date = new Date()): Promise<boolean> {
  const today = now.toISOString().slice(0, 10);
  if ((await env.KILL_SWITCH_STATE.get(METRIC_FAILURE_ALERT_KEY)) === today) return false;
  await env.KILL_SWITCH_STATE.put(METRIC_FAILURE_ALERT_KEY, today);
  return true;
}
