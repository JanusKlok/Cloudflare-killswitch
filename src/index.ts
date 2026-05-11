import type { Env } from './types.js';
import { CONFIG } from './config.js';
import { runScheduled } from './scheduled.js';
import { handleFetch } from './recovery.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env, CONFIG);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, CONFIG));
  },
};
