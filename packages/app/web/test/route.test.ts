import { describe, it, expect } from 'bun:test';
import { parseRoute, buildPath, toScope, toView, DEFAULT_ROUTE } from '../src/lib/route';

/**
 * The URL is the source of truth for what the dashboard shows, so a reload,
 * a bookmark, or the back button lands where you were.
 *
 * Mailbox (all mail / an alias / a label) and folder are independent axes.
 * Picking Starred while an alias is open used to drop back to everyone's
 * mail at /inbox; it now stays inside the alias.
 */

describe('parseRoute', () => {
  it('defaults to the inbox at the root', () => {
    expect(parseRoute('/')).toEqual(DEFAULT_ROUTE);
  });

  it('reads each folder in the unscoped mailbox', () => {
    for (const view of ['inbox', 'starred', 'archived', 'trash'] as const) {
      expect(parseRoute(`/${view}`)).toMatchObject({ view, aliasId: null, labelId: null });
    }
  });

  it('reads a folder nested inside an alias', () => {
    expect(parseRoute('/alias/a1/starred')).toMatchObject({ aliasId: 'a1', view: 'starred' });
    expect(parseRoute('/label/l1/trash')).toMatchObject({ labelId: 'l1', view: 'trash' });
  });

  it('defaults to the inbox inside a scope with no folder', () => {
    expect(parseRoute('/alias/a1')).toMatchObject({ aliasId: 'a1', view: 'inbox', emailId: null });
  });

  it('reads the open message at every depth', () => {
    expect(parseRoute('/inbox/01ABC').emailId).toBe('01ABC');
    expect(parseRoute('/alias/a1/starred/01ABC')).toMatchObject({
      aliasId: 'a1', view: 'starred', emailId: '01ABC',
    });
  });

  it('still reads links written before folders nested under scopes', () => {
    // /alias/:id/:emailId — no folder segment.
    expect(parseRoute('/alias/a1/01ABC')).toMatchObject({
      aliasId: 'a1', view: 'inbox', emailId: '01ABC',
    });
  });

  it('reads the search term from the query string', () => {
    expect(parseRoute('/inbox', '?q=invoice%202024').q).toBe('invoice 2024');
    expect(parseRoute('/alias/a1/trash', '?q=x')).toMatchObject({
      aliasId: 'a1', view: 'trash', q: 'x',
    });
  });

  it('decodes segments', () => {
    expect(parseRoute(`/label/${encodeURIComponent('needs review')}/inbox`).labelId).toBe('needs review');
  });

  it('falls back to the inbox for anything unrecognised', () => {
    expect(parseRoute('/nope')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('/alias')).toEqual(DEFAULT_ROUTE);
    expect(parseRoute('')).toEqual(DEFAULT_ROUTE);
  });
});

describe('buildPath', () => {
  it('renders the unscoped mailbox', () => {
    expect(buildPath(DEFAULT_ROUTE)).toBe('/inbox');
    expect(buildPath({ ...DEFAULT_ROUTE, view: 'trash' })).toBe('/trash');
  });

  it('nests the folder under the scope', () => {
    expect(buildPath({ ...DEFAULT_ROUTE, aliasId: 'a1' })).toBe('/alias/a1/inbox');
    expect(buildPath({ ...DEFAULT_ROUTE, aliasId: 'a1', view: 'starred' })).toBe('/alias/a1/starred');
    expect(buildPath({ ...DEFAULT_ROUTE, labelId: 'l1', view: 'trash' })).toBe('/label/l1/trash');
  });

  it('appends the open message and the search term', () => {
    expect(buildPath({ ...DEFAULT_ROUTE, emailId: '01ABC' })).toBe('/inbox/01ABC');
    expect(buildPath({ ...DEFAULT_ROUTE, aliasId: 'a1', view: 'starred', emailId: '01X', q: 'a b' }))
      .toBe('/alias/a1/starred/01X?q=a%20b');
  });

  it('round-trips with parseRoute', () => {
    const routes = [
      DEFAULT_ROUTE,
      { ...DEFAULT_ROUTE, view: 'starred' as const, emailId: '01ABC' },
      { ...DEFAULT_ROUTE, aliasId: 'a1', view: 'trash' as const, emailId: '01X', q: 'hello world' },
      { ...DEFAULT_ROUTE, labelId: 'needs review', view: 'archived' as const },
    ];
    for (const route of routes) {
      const [pathname, search] = buildPath(route).split('?');
      expect(parseRoute(pathname!, search ? `?${search}` : '')).toEqual(route);
    }
  });
});

describe('toView', () => {
  it('stays inside the alias — the reported bug', () => {
    const inAlias = { ...DEFAULT_ROUTE, aliasId: 'a1' };
    const starred = toView(inAlias, 'starred');

    expect(starred.aliasId).toBe('a1');
    expect(buildPath(starred)).toBe('/alias/a1/starred');
  });

  it('stays inside a label too', () => {
    expect(toView({ ...DEFAULT_ROUTE, labelId: 'l1' }, 'trash')).toMatchObject({
      labelId: 'l1', view: 'trash',
    });
  });

  it('closes the open message, which belongs to the previous folder', () => {
    expect(toView({ ...DEFAULT_ROUTE, emailId: '01ABC' }, 'trash').emailId).toBeNull();
  });

  it('keeps the search term while moving between folders', () => {
    expect(toView({ ...DEFAULT_ROUTE, q: 'invoice' }, 'archived').q).toBe('invoice');
  });
});

describe('toScope', () => {
  it('switches mailbox and starts at its inbox', () => {
    expect(toScope({ aliasId: 'a1' })).toMatchObject({ aliasId: 'a1', view: 'inbox', labelId: null });
  });

  it('returns to all mail with no argument', () => {
    expect(toScope()).toEqual(DEFAULT_ROUTE);
  });

  it('makes alias and label mutually exclusive', () => {
    expect(toScope({ aliasId: 'a1', labelId: 'l1' })).toMatchObject({ aliasId: 'a1', labelId: null });
    expect(toScope({ labelId: 'l1' })).toMatchObject({ labelId: 'l1', aliasId: null });
  });

  it('drops the open message and the search', () => {
    // Carrying a filter into a different mailbox shows an apparently empty
    // list, which reads as a bug.
    expect(toScope({ aliasId: 'a1' })).toMatchObject({ emailId: null, q: '' });
  });
});
