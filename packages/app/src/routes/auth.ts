import { Hono } from 'hono';
import { loginHandler } from '../middleware/auth';
import { AppContext } from '../types';

export const authRoutes = new Hono<AppContext>();

authRoutes.post('/login', loginHandler);
