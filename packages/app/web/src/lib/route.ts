import type { EmailView } from '@mailriz/shared';

/**
 * URL as the source of truth for what the dashboard is showing.
 *
 * Everything that decides the visible screen lives in the address bar, so a
 * reload, a bookmark, or the back button all land where you were instead of
 * resetting to the inbox.
 *
 *   /inbox                  /starred  /archived  /trash
 *   /alias/:aliasId         a single alias
 *   /label/:labelId         a single label
 *   …/:emailId              with a message open
 *   ?q=…                    search, on any of the above
 */

export const VIEW_IDS = ['inbox', 'starred', 'archived', 'trash'] as const;

function isView(value: string): value is EmailView {
  return (VIEW_IDS as readonly string[]).includes(value);
}

export interface Route {
  view: EmailView;
  aliasId: string | null;
  labelId: string | null;
  emailId: string | null;
  q: string;
}

export const DEFAULT_ROUTE: Route = {
  view: 'inbox',
  aliasId: null,
  labelId: null,
  emailId: null,
  q: '',
};

/**
 * Read a route out of a location. Anything unrecognised falls back to the
 * inbox rather than erroring — a stale bookmark should still open the app.
 */
export function parseRoute(pathname: string, search = ''): Route {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(search).get('q') || '';
  const [first, second, third] = segments;

  if (first === 'alias' && second) {
    return { ...DEFAULT_ROUTE, aliasId: second, emailId: third || null, q };
  }
  if (first === 'label' && second) {
    return { ...DEFAULT_ROUTE, labelId: second, emailId: third || null, q };
  }
  if (first && isView(first)) {
    return { ...DEFAULT_ROUTE, view: first, emailId: second || null, q };
  }
  return { ...DEFAULT_ROUTE, q };
}

/** Render a route back to a path. Inverse of parseRoute. */
export function buildPath(route: Route): string {
  const enc = encodeURIComponent;

  const base = route.aliasId
    ? `/alias/${enc(route.aliasId)}`
    : route.labelId
      ? `/label/${enc(route.labelId)}`
      : `/${route.view}`;

  const path = route.emailId ? `${base}/${enc(route.emailId)}` : base;
  return route.q ? `${path}?q=${enc(route.q)}` : path;
}

/**
 * Scope changes (folder, alias, label) are mutually exclusive and always drop
 * the open message — the message almost certainly isn't in the new scope.
 */
export function scopeTo(patch: Partial<Route>): Route {
  return { ...DEFAULT_ROUTE, ...patch, emailId: null };
}
