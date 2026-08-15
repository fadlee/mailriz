/**
 * Hostname the request came in on.
 *
 * Prefers the Host header, falling back to the URL — a Request constructed
 * directly (tests, internal dispatch) carries no Host header, and returning
 * an empty string there silently produced aliases on the domain "".
 */
export function requestHost(c: { req: { header: (name: string) => string | undefined; url: string } }): string {
  const header = c.req.header('Host');
  if (header) return header.split(':')[0] || '';
  try {
    return new URL(c.req.url).hostname;
  } catch {
    return '';
  }
}
