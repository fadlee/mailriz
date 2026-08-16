import { useCallback, useEffect, useState } from 'react';
import { buildPath, parseRoute, type Route } from './route';

function current(): Route {
  return parseRoute(window.location.pathname, window.location.search);
}

/**
 * Keep the visible screen and the address bar in step.
 *
 * `navigate` pushes by default so the back button walks the trail. Pass
 * `replace` for changes that shouldn't each become a history entry — typing
 * in the search box would otherwise leave one entry per keystroke.
 */
export function useRoute(): { route: Route; navigate: (next: Route, opts?: { replace?: boolean }) => void } {
  const [route, setRoute] = useState<Route>(current);

  // Back/forward move through history without notifying React.
  useEffect(() => {
    const onPop = () => setRoute(current());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Land on a canonical path so "/" doesn't sit in history as its own entry.
  useEffect(() => {
    const canonical = buildPath(current());
    if (window.location.pathname + window.location.search !== canonical) {
      window.history.replaceState(null, '', canonical);
    }
  }, []);

  const navigate = useCallback((next: Route, opts?: { replace?: boolean }) => {
    const path = buildPath(next);
    if (path !== window.location.pathname + window.location.search) {
      if (opts?.replace) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}
