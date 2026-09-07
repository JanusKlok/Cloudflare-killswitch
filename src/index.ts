import type { Env } from './types.js';
import { CONFIG } from './config.js';
import { runScheduled } from './scheduled.js';
import { handleFetch } from './recovery.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env, CONFIG);
    } catch (err) {
      // Never surface a stack trace to the caller: /restore is reachable during
      // a kill, so its error responses are the most exposed surface here.
      console.error('fetch handler failed:', err);
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil swallows rejections, so without this an unexpected throw
    // (a KV blip in readState, say) would lose the tick with nothing logged.
    ctx.waitUntil(
      runScheduled(env, CONFIG).catch((err: unknown) => {
        console.error('scheduled tick failed:', err);
      }),
    );
  },
};
