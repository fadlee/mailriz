import { Hono } from 'hono';
import { AppContext } from '../types';
import { MeResponse, AuthMode } from '@mailriz/shared';
import { requestHost } from '../lib/host';

export const meRoutes = new Hono<AppContext>();

meRoutes.get('/', async (c) => {
  const e = c.env;
  const user = c.get('user');
  // The domain the UI shows next to aliases is the mail domain, not the host
  // the dashboard happens to be served from.
  const domain = e.MAIL_DOMAIN || requestHost(c);
  const body: MeResponse = {
    email: user.email,
    mode: user.mode as AuthMode,
    domain,
  };
  return c.json(body);
});
