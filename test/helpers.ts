/** Normalises the many shapes a fetch mock can be called with into a URL
 *  string, so assertions about which endpoints were hit stay readable. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
