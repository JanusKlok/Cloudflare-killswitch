import { fetchRetry } from './retry.js';

export const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  result: T;
  success: boolean;
  errors?: { code: number; message: string }[];
}

/** A structured Cloudflare API failure.  Carries the HTTP status and the
 *  envelope's error codes so callers can branch on *why* a call failed instead
 *  of substring-matching the message. */
export class CfApiError extends Error {
  readonly status: number;
  readonly codes: number[];

  constructor(status: number, codes: number[], message: string) {
    super(message);
    this.name = 'CfApiError';
    this.status = status;
    this.codes = codes;
  }

  /** A definite "this resource does not exist".  Deliberately status-only:
   *  callers use it to decide whether to *create* a resource, so it must never
   *  be true for an expired token, a rate limit, or a gateway error. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface CfFetchOptions extends RequestInit {
  /** Leave off for non-idempotent writes.  A retry after a request that
   *  actually succeeded creates a second resource whose id is never recorded,
   *  which for a WAF rule means a block nothing can lift. */
  retry?: boolean;
}

export async function cfFetch<T>(
  token: string,
  path: string,
  options: CfFetchOptions = {},
): Promise<T> {
  const { retry = true, headers, ...init } = options;
  const url = `${CF_API}${path}`;
  // A FormData body must set its own multipart Content-Type: it carries the
  // boundary, and forcing application/json here makes the API reject the body.
  const isMultipart = init.body instanceof FormData;
  const request: RequestInit = {
    ...init,
    headers: {
      ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `Bearer ${token}`,
      ...(headers as Record<string, string> | undefined),
    },
  };

  const res = retry ? await fetchRetry(url, request) : await fetch(url, request);

  let body: CfEnvelope<T>;
  try {
    body = (await res.json()) as CfEnvelope<T>;
  } catch {
    // Gateway errors, rate limits and WAF challenges often return HTML rather
    // than the JSON envelope.  Without this the SyntaxError would surface as an
    // opaque failure indistinguishable from a genuine 404.
    throw new CfApiError(
      res.status,
      [],
      `Cloudflare API returned a non-JSON ${res.status} response for ${path}`,
    );
  }

  if (!body.success) {
    const errors = body.errors ?? [];
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'unknown error';
    throw new CfApiError(
      res.status,
      errors.map((e) => e.code),
      `Cloudflare API error (${res.status}): ${detail}`,
    );
  }

  return body.result;
}
