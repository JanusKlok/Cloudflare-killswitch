import type { Env } from "./configuration.ts";
import { Engine } from "./engine.ts";
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
export class Guard {
  private queue: Promise<unknown> = Promise.resolve();
  private engine: Engine;
  constructor(state: DurableObjectState, env: Env) {
    this.engine = new Engine(state.storage, env);
  }
  fetch(request: Request): Promise<Response> {
    // Serialize across awaited network I/O, including cutoff/rearm races.
    const run = this.queue.then(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (path === "/tick") return reply(await this.engine.tick());
        if (path === "/cutoff")
          return reply(await this.engine.tick(Date.now(), true));
        if (path === "/rearm")
          return reply(
            await this.engine.rearm(
              request.headers.get("X-Confirm-Cutoff") ?? "",
            ),
          );
        const s = await this.engine.state();
        const stale =
          !s.lastCheck || Date.now() - Date.parse(s.lastCheck) > 20 * 60000;
        return reply(
          { ...s, heartbeatStale: stale },
          stale || s.errors.length || s.latched ? 503 : 200,
        );
      } catch {
        return reply(
          {
            error:
              "guard operation failed; inspect configuration, permissions and durable state",
          },
          503,
        );
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (
      !env.ADMIN_SECRET ||
      request.headers.get("Authorization") !== `Bearer ${env.ADMIN_SECRET}`
    )
      return new Response("Not found", { status: 404 });
    const path = new URL(request.url).pathname;
    if (!(
      (request.method === "GET" && path === "/status") ||
      (request.method === "POST" && ["/cutoff", "/rearm"].includes(path))
    ))
      return new Response("Not found", { status: 404 });
    return env.GUARD.get(env.GUARD.idFromName("ferrecar-v1")).fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const result = await env.GUARD.get(
      env.GUARD.idFromName("ferrecar-v1"),
    ).fetch("https://guard.internal/tick");
    const s = (await result.json()) as {
      latched?: boolean;
      warning?: boolean;
      errors?: string[];
      reason?: string;
    };
    if (!result.ok || s.latched || s.warning || s.errors?.length)
      console.error(
        JSON.stringify({
          guard: "attention",
          latched: s.latched,
          warning: s.warning,
          errors: s.errors,
          reason: s.reason,
        }),
      );
    if (!result.ok)
      throw Error("guard execution failed; independent status check required");
  },
} satisfies ExportedHandler<Env>;
