import type { Env } from '../types.js';
import { fetchRetry } from '../util/retry.js';

const GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string; locations?: unknown[] }[];
}

export async function gql<T>(
  env: Env,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchRetry(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as GqlResponse<T>;

  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  if (!body.data) {
    throw new Error('GraphQL response contained no data');
  }

  return body.data;
}
