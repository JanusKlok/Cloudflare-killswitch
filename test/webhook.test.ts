import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import { sendWebhook } from '../src/actions/webhook.js';
import type { Env } from '../src/types.js';

const withUrl = (url: string | undefined): Env => ({ ...env, ALERT_WEBHOOK_URL: url });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  return { url: String(url), init, headers: new Headers(init.headers) };
}

describe('sendWebhook', () => {
  it('is a no-op when the URL is unset', async () => {
    await sendWebhook(withUrl(undefined), 's', 'b');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http://ntfy.sh/topic', 'not a url', 'ftp://x.example/y'])(
    'skips non-https or invalid URL %s',
    async (u) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await sendWebhook(withUrl(u), 's', 'b');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
      expect(err.mock.calls.flat().join(' ')).not.toContain(u);
    },
  );

  it('sends Discord JSON { content }', async () => {
    await sendWebhook(withUrl('https://discord.com/api/webhooks/1/tok'), 'Subj', 'Body');
    const { init, headers } = lastCall();
    expect(init.method).toBe('POST');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ content: '**Subj**\nBody' });
  });

  it('truncates Discord content to 2000 characters', async () => {
    await sendWebhook(withUrl('https://discordapp.com/api/webhooks/1/tok'), 'S', 'x'.repeat(5000));
    const { content } = JSON.parse(lastCall().init.body as string) as { content: string };
    expect(content.length).toBe(2000);
    expect(content.endsWith('…')).toBe(true);
  });

  it('does not split a surrogate pair when truncating', async () => {
    await sendWebhook(withUrl('https://discord.com/api/webhooks/1/tok'), '', '😀'.repeat(2000));
    const { content } = JSON.parse(lastCall().init.body as string) as { content: string };
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('sends Slack JSON { text }', async () => {
    await sendWebhook(withUrl('https://hooks.slack.com/services/T0/B0/X'), 'Subj', 'Body');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ text: '*Subj*\nBody' });
  });

  it('sends ntfy-style plain text with an ASCII Title header', async () => {
    await sendWebhook(withUrl('https://ntfy.sh/my-topic'), 'Kill ✓\r\nswitch', 'Body');
    const { url, init, headers } = lastCall();
    expect(url).toBe('https://ntfy.sh/my-topic');
    expect(init.body).toBe('Body');
    expect(headers.get('content-type')).toContain('text/plain');
    expect(headers.get('title')).toBe('Kill switch');
  });

  it('throws on non-2xx without leaking the URL', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    const err = await sendWebhook(withUrl('https://ntfy.sh/secret-topic'), 's', 'b').catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('403');
    expect((err as Error).message).not.toContain('secret-topic');
  });

  it('wraps network errors without leaking the URL', async () => {
    fetchMock.mockRejectedValue(new Error('failed https://ntfy.sh/secret-topic'));
    const err = await sendWebhook(withUrl('https://ntfy.sh/secret-topic'), 's', 'b').catch(
      (e: Error) => e,
    );
    expect((err as Error).message).not.toContain('secret-topic');
  });

  it('passes an abort signal for the timeout', async () => {
    await sendWebhook(withUrl('https://ntfy.sh/t'), 's', 'b');
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });
});
