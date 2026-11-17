import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';

vi.mock('../src/actions/email.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../src/actions/webhook.js', () => ({ sendWebhook: vi.fn() }));

import { sendAlert } from '../src/actions/email.js';
import { sendWebhook } from '../src/actions/webhook.js';
import { sendAlerts, shouldAlertMetricFailure } from '../src/alerts.js';

beforeEach(() => {
  vi.mocked(sendAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(sendWebhook).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('sendAlerts', () => {
  it('sends to both channels', async () => {
    await sendAlerts(env, 'subj', 'body');
    expect(sendAlert).toHaveBeenCalledWith(env, 'subj', 'body');
    expect(sendWebhook).toHaveBeenCalledWith(env, 'subj', 'body');
  });

  it('isolates a failing channel, logs it, and never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sendAlert).mockRejectedValue(new Error('email down'));
    await expect(sendAlerts(env, 's', 'b')).resolves.toBeUndefined();
    expect(sendWebhook).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.flat().join(' ')).toContain('email down');

    vi.mocked(sendAlert).mockResolvedValue(undefined);
    vi.mocked(sendWebhook).mockRejectedValue(new Error('hook down'));
    await expect(sendAlerts(env, 's', 'b')).resolves.toBeUndefined();
    expect(err.mock.calls.flat().join(' ')).toContain('hook down');
  });

  it('survives a synchronous throw from a channel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sendAlert).mockImplementation(() => {
      throw new Error('sync boom');
    });
    await expect(sendAlerts(env, 's', 'b')).resolves.toBeUndefined();
    expect(sendWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('shouldAlertMetricFailure', () => {
  const KEY = 'metric-failure-alert-day';
  beforeEach(async () => {
    await env.KILL_SWITCH_STATE.delete(KEY);
  });

  it('returns true once per UTC day and writes KV only then', async () => {
    const put = vi.spyOn(env.KILL_SWITCH_STATE, 'put');
    expect(await shouldAlertMetricFailure(env, new Date('2026-11-17T00:00:01Z'))).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(await env.KILL_SWITCH_STATE.get(KEY)).toBe('2026-11-17');

    expect(await shouldAlertMetricFailure(env, new Date('2026-11-17T23:59:59Z'))).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);

    expect(await shouldAlertMetricFailure(env, new Date('2026-11-18T00:00:00Z'))).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
  });
});
