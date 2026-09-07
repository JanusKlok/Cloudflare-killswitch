import type { Env } from '../types.js';

/** Strip CR/LF so untrusted strings cannot inject extra SMTP headers. */
function sanitizeHeader(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Send an alert email via the Cloudflare Email Routing send_email binding.
 * Silently no-ops when SEND_EMAIL binding or EMAIL_FROM/TO vars are absent,
 * so email is fully optional.
 */
export async function sendAlert(env: Env, subject: string, body: string): Promise<void> {
  if (!env.SEND_EMAIL || !env.EMAIL_FROM || !env.EMAIL_TO) return;

  const from = sanitizeHeader(env.EMAIL_FROM);
  const to = sanitizeHeader(env.EMAIL_TO);
  const safeSubject = sanitizeHeader(subject);

  const raw = [
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `From: Cloudflare Kill Switch <${from}>`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    ``,
    body,
  ].join('\r\n');

  // Built as a ReadableStream directly rather than by writing into a
  // TransformStream: awaiting writer.close() there blocks until something
  // reads the readable end, and the only reader is the SEND_EMAIL.send() call
  // below — which cannot start until this function gets past the await. That
  // deadlocked the alert for the full Worker time limit.
  const bytes = new TextEncoder().encode(raw);
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  // EmailMessage is a Workers runtime global (from @cloudflare/workers-types)
  const message = new EmailMessage(from, to, readable);
  await env.SEND_EMAIL.send(message);
}
