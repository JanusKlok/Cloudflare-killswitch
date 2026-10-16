import type { Env } from "./configuration.ts";
import { Engine } from "./engine.ts";
export function authorized(header: string | null, secret: string): boolean {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 512 ||
    header?.length !== secret.length + 7
  )
    return false;
  const encode = new TextEncoder();
  const supplied = encode.encode(header),
    expected = encode.encode(`Bearer ${secret}`);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  };
  return (
    supplied.byteLength === expected.byteLength &&
    subtle.timingSafeEqual(supplied, expected)
  );
}
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
        if (path === "/tick" || path === "/cutoff") {
          const s = await this.engine.tick(Date.now(), path === "/cutoff");
          return reply(
            s,
            s.errors.length
              ? 503
              : path === "/cutoff" && !s.latched
                ? 409
                : 200,
          );
        }
        if (path === "/recovery-check")
          return reply(
            await this.engine.recoveryCheck(
              request.headers.get("X-Confirm-Cutoff") ?? "",
            ),
          );
        if (path === "/rearm")
          return reply(
            await this.engine.rearm(
              request.headers.get("X-Confirm-Cutoff") ?? "",
            ),
          );
        const s = await this.engine.state();
        const stale =
          !s.lastCheck ||
          Date.now() < Date.parse(s.lastCheck) ||
          Date.now() - Date.parse(s.lastCheck) > 20 * 60000;
        return reply(
          {
            ...s,
            heartbeatStale: stale,
            enforcementEnabled: s.config?.enabled === true,
          },
          stale || s.errors.length || s.latched || !s.config?.enabled
            ? 503
            : 200,
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
    const path = new URL(request.url).pathname;
    if (!(
      (request.method === "GET" && path === "/status") ||
      (request.method === "POST" &&
        ["/cutoff", "/rearm", "/recovery-check"].includes(path))
    ))
      return new Response("Not found", { status: 404 });
    if (!authorized(request.headers.get("Authorization"), env.ADMIN_SECRET))
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
