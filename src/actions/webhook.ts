import type { Env } from '../types.js';

// https://docs.discord.com/developers/resources/webhook (Execute Webhook)
const DISCORD_CONTENT_LIMIT = 2000;
// ntfy turns messages over 4,096 bytes into attachments; stay well under it
// (https://docs.ntfy.sh/publish/).
const NTFY_BODY_LIMIT = 3500;
const WEBHOOK_TIMEOUT_MS = 5_000;

type Flavor = 'discord' | 'slack' | 'plain';

function flavorOf(url: URL): Flavor {
  const host = url.hostname.toLowerCase();
  const isHost = (h: string) => host === h || host.endsWith(`.${h}`);
  if (
    (isHost('discord.com') || isHost('discordapp.com')) &&
    url.pathname.startsWith('/api/webhooks/')
  )
    return 'discord';
  if (host === 'hooks.slack.com') return 'slack';
  return 'plain';
}

/** Truncate to `max` UTF-16 units without leaving half of a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** HTTP header values must be Latin-1-safe in the Workers runtime: keep printable ASCII only. */
function asciiHeader(s: string): string {
  return s
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * POST an alert to the generic webhook in ALERT_WEBHOOK_URL. Formats the
 * payload by host (Discord, Slack) and falls back to an ntfy-style plain-text
 * POST with a Title header for anything else. No-ops when the secret is unset
 * or not https. Throws on a non-2xx response or network failure; the error
 * message never contains the URL, since the URL itself is the credential.
 */
export async function sendWebhook(env: Env, subject: string, body: string): Promise<void> {
  const raw = env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) return;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error('ALERT_WEBHOOK_URL is not a valid URL; webhook alert skipped');
    return;
  }
  if (url.protocol !== 'https:') {
    console.error('ALERT_WEBHOOK_URL must be https; webhook alert skipped');
    return;
  }

  let init: RequestInit;
  switch (flavorOf(url)) {
    case 'discord':
      init = {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: truncate(`**${subject}**\n${body}`, DISCORD_CONTENT_LIMIT),
        }),
      };
      break;
    case 'slack':
      init = {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${subject}*\n${body}` }),
      };
      break;
    default:
      init = {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: asciiHeader(subject) },
        body: truncate(body, NTFY_BODY_LIMIT),
      };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    throw new Error(`Webhook request failed (${name})`, { cause: err });
  }
  // Drain so the connection is released; the body may echo the request.
  await res.body?.cancel();
  if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
}
