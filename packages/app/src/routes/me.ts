import { Hono } from 'hono';
import { AppContext } from '../types';
import { MeResponse, AuthMode } from '@mailriz/shared';

export const meRoutes = new Hono<AppContext>();

meRoutes.get('/', async (c) => {
  const e = c.env;
  const user = c.get('user');
  const domain = c.req.header('Host')?.split(':')[0] || '';
  const body: MeResponse = {
    email: user.email,
    mode: user.mode as AuthMode,
    domain,
  };
  return c.json(body);
});
