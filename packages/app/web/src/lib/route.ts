import type { EmailView } from '@mailriz/shared';

/**
 * URL as the source of truth for what the dashboard is showing.
 *
 * A scope (all mail, one alias, one label) and a folder within it are
 * independent: picking Starred while an alias is open shows that alias's
 * starred mail, not everyone's. The path reflects that nesting.
 *
 *   /inbox                        all mail, inbox
 *   /starred  /archived  /trash
 *   /alias/:aliasId/inbox         one alias, inbox
 *   /label/:labelId/starred       one label, starred
 *   …/:emailId                    with a message open
 *   ?q=…                          search, on any of the above
 */

export const VIEW_IDS = ['inbox', 'starred', 'archived', 'trash'] as const;

function isView(value: string | undefined): value is EmailView {
  return !!value && (VIEW_IDS as readonly string[]).includes(value);
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

  let aliasId: string | null = null;
  let labelId: string | null = null;
  let rest = segments;

  if (segments[0] === 'alias' && segments[1]) {
    aliasId = segments[1];
    rest = segments.slice(2);
  } else if (segments[0] === 'label' && segments[1]) {
    labelId = segments[1];
    rest = segments.slice(2);
  }

  // Inside a scope the folder is optional: links written before folders
  // nested under scopes look like /alias/:id/:emailId.
  const view = isView(rest[0]) ? rest[0] : 'inbox';
  const emailId = (isView(rest[0]) ? rest[1] : rest[0]) || null;

  if (!aliasId && !labelId && !isView(segments[0]) && segments.length > 0) {
    return { ...DEFAULT_ROUTE, q };
  }

  return { view, aliasId, labelId, emailId, q };
}

/** Render a route back to a path. Inverse of parseRoute. */
export function buildPath(route: Route): string {
  const enc = encodeURIComponent;

  const scope = route.aliasId
    ? `/alias/${enc(route.aliasId)}`
    : route.labelId
      ? `/label/${enc(route.labelId)}`
      : '';

  const path = `${scope}/${route.view}` + (route.emailId ? `/${enc(route.emailId)}` : '');
  return route.q ? `${path}?q=${enc(route.q)}` : path;
}

/**
 * Switch mailbox: all mail, one alias, or one label.
 *
 * Starts at the inbox of the new scope and drops the open message and the
 * search — carrying either into a different mailbox shows a filtered, often
 * empty list that reads as a bug.
 */
export function toScope(patch: { aliasId?: string | null; labelId?: string | null } = {}): Route {
  return {
    ...DEFAULT_ROUTE,
    aliasId: patch.aliasId ?? null,
    labelId: patch.aliasId ? null : patch.labelId ?? null,
  };
}

/**
 * Switch folder without leaving the current mailbox — picking Starred inside
 * an alias shows that alias's starred mail.
 */
export function toView(route: Route, view: EmailView): Route {
  return { ...route, view, emailId: null };
}
