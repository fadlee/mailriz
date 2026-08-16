import { useEffect, useRef, useState } from 'react';

/**
 * Subscribe to new-mail notifications.
 *
 * The stream only reports *that* something arrived. Reloading is left to the
 * caller, which goes through the normal list query and therefore already
 * knows the active folder, alias, label and search — the stream never has to
 * learn any of that.
 *
 * Reconnection is `EventSource`'s own, not ours: the server closes each
 * connection after a few minutes to stay inside the Worker CPU budget, and
 * the browser dials back automatically, replaying the last event id so
 * nothing that landed in the gap is missed.
 *
 * Cookies ride along on same-origin EventSource requests, so this works under
 * both session auth and Cloudflare Access without setting any header — which
 * EventSource could not do anyway.
 */
export function useLiveMail(onMail: () => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  // Held in a ref so a changing callback doesn't tear down the connection.
  const handler = useRef(onMail);
  handler.current = onMail;

  useEffect(() => {
    let source: EventSource | null = null;
    let stopped = false;

    try {
      source = new EventSource('/api/updates/stream');
    } catch {
      return;
    }

    source.addEventListener('open', () => {
      if (!stopped) setConnected(true);
    });

    source.addEventListener('mail', () => {
      if (!stopped) handler.current();
    });

    source.addEventListener('error', () => {
      // Fires both on a dropped connection and on the server's scheduled
      // close. EventSource retries by itself; this only reflects the gap.
      if (!stopped) setConnected(false);
    });

    return () => {
      stopped = true;
      source?.close();
    };
  }, []);

  return { connected };
}
