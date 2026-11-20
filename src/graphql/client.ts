import type { Env } from '../types.js';
import { fetchRetry } from '../util/retry.js';

const GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

// The merged usage query spans month-long windows over several datasets and
// can take well over the 10 s default; a cron tick may run 15 min of wall time
// and waiting on fetch costs no CPU, so a long wait is cheap.
export const GRAPHQL_TIMEOUT_MS = 30_000;

export interface GqlError {
  message: string;
  /** Root-to-node path of the failing field, e.g. ["viewer","accounts",0,"kvStorageAdaptiveGroups"]. */
  path?: (string | number)[];
}

export interface GqlResult<T> {
  data: T | null;
  errors: GqlError[];
}

/** Sends one query and returns `data` and `errors` as received, so a caller can
 *  use partial data.  Throws only when no GraphQL answer exists at all (network,
 *  auth, rate limit, 5xx, unparseable body). */
export async function gqlRaw<T>(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResult<T>> {
  const res = await fetchRetry(
    GQL_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    },
    undefined,
    GRAPHQL_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text();
    // Dataset-level rejections (time range too large, too many fields) come as
    // HTTP 400 with a normal errors array; keep them attributable to a dataset.
    if (res.status === 400) {
      try {
        const body = JSON.parse(text) as { errors?: GqlError[] };
        if (Array.isArray(body.errors) && body.errors.length > 0) {
          return { data: null, errors: body.errors };
        }
      } catch {
        // fall through to the HTTP error
      }
    }
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }

  const body = (await res.json()) as { data?: T | null; errors?: GqlError[] | null };
  return { data: body.data ?? null, errors: body.errors ?? [] };
}

export async function gql<T>(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const { data, errors } = await gqlRaw<T>(env, query, variables);

  if (errors.length) {
    throw new Error(`GraphQL errors: ${errors.map((e) => e.message).join('; ')}`);
  }

  if (!data) {
    throw new Error('GraphQL response contained no data');
  }

  return data;
}
