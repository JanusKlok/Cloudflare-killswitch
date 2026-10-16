export type Api = <T>(
  path: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`Cloudflare HTTP ${status}`);
  }
}
export function bounded(call: Api, deadline: number): Api {
  return <T>(path: string, body?: unknown, method?: string) => {
    if (Date.now() >= deadline)
      return Promise.reject(Error("tick API time budget exhausted"));
    return call<T>(path, body, method);
  };
}
// No response bodies or credentials in errors. Non-idempotent POST is not retried.
export function api(token: string, fetcher: typeof fetch = fetch): Api {
  return async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "PUT",
  ): Promise<T> => {
    if (!token || !path.startsWith("/") || path.includes("://"))
      throw Error("API configuration");
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (
          (r.status === 429 || r.status >= 500) &&
          attempt === 0 &&
          method !== "POST"
        ) {
          await r.body?.cancel();
          continue;
        }
        if (!r.ok) {
          await r.body?.cancel();
          throw new ApiError(r.status);
        }
        const reader = r.body?.getReader();
        if (!reader) throw Error("empty API response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 262144) {
            await reader.cancel();
            throw Error("API payload limit");
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const j = JSON.parse(new TextDecoder().decode(bytes));
        if (
          !j ||
          typeof j !== "object" ||
          j.success === false ||
          (j.errors != null && (!Array.isArray(j.errors) || j.errors.length)) ||
          (path !== "/graphql" && j.success !== true)
        )
          throw Error("Cloudflare response error");
        if (
          j.result_info &&
          ((j.result_info.total_pages ?? 1) > 1 ||
            (j.result_info.total_count ?? 0) > (j.result?.length ?? 0))
        )
          throw Error("inventory truncated");
        const value = path === "/graphql" ? j.data : j.result;
        if (value === undefined || value === null)
          throw Error("missing API result");
        return value as T;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
export function rows<T>(value: unknown, limit: number): T[] {
  if (!Array.isArray(value) || value.length >= limit)
    throw Error("missing or truncated dataset");
  return value as T[];
}
export function count(n: unknown): number {
  if (
    typeof n !== "number" ||
    !Number.isFinite(n) ||
    n < 0 ||
    n > Number.MAX_SAFE_INTEGER
  )
    throw Error("invalid usage number");
  return Math.ceil(n);
}
