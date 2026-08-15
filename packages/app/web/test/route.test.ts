import { describe, it, expect } from 'bun:test';
import { parseRoute, buildPath, scopeTo, DEFAULT_ROUTE } from '../src/lib/route';

/**
 * The URL is the source of truth for what the dashboard shows, so that a
 * reload, a bookmark, or the back button lands where you were instead of
 * resetting to the inbox.
 */

describe('parseRoute', () => {
  it('defaults to the inbox at the root', () => {
    expect(parseRoute('/')).toEqual(DEFAULT_ROUTE);
  });

  it('reads each folder', () => {
    for (const view of ['inbox', 'starred', 'archived', 'trash'] as const) {
      expect(parseRoute(`/${view}`).view).toBe(view);
    }
  });

  it('reads an alias and a label scope', () => {
    expect(parseRoute('/alias/a1')).toMatchObject({ aliasId: 'a1', labelId: null });
    expect(parseRoute('/label/l1')).toMatchObject({ labelId: 'l1', aliasId: null });
  });

  it('reads the open message from the trailing segment', () => {
    expect(parseRoute('/inbox/01ABC').emailId).toBe('01ABC');
    expect(parseRoute('/alias/a1/01ABC')).toMatchObject({ aliasId: 'a1', emailId: '01ABC' });
    expect(parseRoute('/label/l1/01ABC')).toMatchObject({ labelId: 'l1', emailId: '01ABC' });
  });

  it('reads the search term from the query string', () => {
    expect(parseRoute('/inbox', '?q=invoice%202024').q).toBe('invoice 2024');
    expect(parseRoute('/alias/a1', '?q=x')).toMatchObject({ aliasId: 'a1', q: 'x' });
  });

  it('decodes segments', () => {
    expect(parseRoute('/label/' + encodeURIComponent('needs review')).labelId).toBe('needs review');
  });

  it('falls back to the inbox for anything unrecognised', () => {
    // A stale bookmark should still open the app rather than erroring.
    expect(parseRoute('/nope')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('/alias')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('/label')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('')).toEqual(DEFAULT_ROUTE);
  });

  it('keeps the search term even on an unrecognised path', () => {
    expect(parseRoute('/nope', '?q=hi')).toMatchObject({ ...DEFAULT_ROUTE, q: 'hi' });
  });
});

describe('buildPath', () => {
  it('renders each kind of scope', () => {
    expect(buildPath(DEFAULT_ROUTE)).toBe('/inbox');
    expect(buildPath({ ...DEFAULT_ROUTE, view: 'trash' })).toBe('/trash');
    expect(buildPath({ ...DEFAULT_ROUTE, aliasId: 'a1' })).toBe('/alias/a1');
    expect(buildPath({ ...DEFAULT_ROUTE, labelId: 'l1' })).toBe('/label/l1');
  });

  it('appends the open message and the search term', () => {
    expect(buildPath({ ...DEFAULT_ROUTE, emailId: '01ABC' })).toBe('/inbox/01ABC');
    expect(buildPath({ ...DEFAULT_ROUTE, q: 'a b' })).toBe('/inbox?q=a%20b');
    expect(buildPath({ ...DEFAULT_ROUTE, aliasId: 'a1', emailId: '01ABC', q: 'x' }))
      .toBe('/alias/a1/01ABC?q=x');
  });

  it('prefers an alias over a folder when both are set', () => {
    expect(buildPath({ ...DEFAULT_ROUTE, view: 'trash', aliasId: 'a1' })).toBe('/alias/a1');
  });

  it('round-trips with parseRoute', () => {
    const routes = [
      DEFAULT_ROUTE,
      { ...DEFAULT_ROUTE, view: 'starred' as const, emailId: '01ABC' },
      { ...DEFAULT_ROUTE, aliasId: 'a1', emailId: '01X', q: 'hello world' },
      { ...DEFAULT_ROUTE, labelId: 'needs review', q: 'a/b' },
    ];
    for (const route of routes) {
      const path = buildPath(route);
      const [pathname, search] = path.split('?');
      expect(parseRoute(pathname!, search ? `?${search}` : '')).toEqual(route);
    }
  });
});

describe('scopeTo', () => {
  it('closes the open message — it is unlikely to be in the new scope', () => {
    expect(scopeTo({ aliasId: 'a1' }).emailId).toBeNull();
  });

  it('makes folder, alias and label mutually exclusive', () => {
    expect(scopeTo({ aliasId: 'a1' })).toMatchObject({ aliasId: 'a1', labelId: null, view: 'inbox' });
    expect(scopeTo({ labelId: 'l1' })).toMatchObject({ labelId: 'l1', aliasId: null });
    expect(scopeTo({ view: 'trash' })).toMatchObject({ view: 'trash', aliasId: null, labelId: null });
  });

  it('carries the search term across a scope change', () => {
    expect(scopeTo({ view: 'trash', q: 'invoice' }).q).toBe('invoice');
  });
});
