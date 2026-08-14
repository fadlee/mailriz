import { Hono } from 'hono';
import { aliasRoutes } from './routes/aliases';
import { attachmentRoutes } from './routes/attachments';
import { emailRoutes } from './routes/emails';
import { labelRoutes } from './routes/labels';
import { meRoutes } from './routes/me';
import { updatesRoutes } from './routes/updates';
import { jwtAuth } from './middleware/auth';
import { AppContext } from './types';

export const app = new Hono<AppContext>();

app.use('/api/*', jwtAuth);

app.route('/api/me', meRoutes);
app.route('/api/aliases', aliasRoutes);
app.route('/api/emails', emailRoutes);
app.route('/api/labels', labelRoutes);
app.route('/api/updates', updatesRoutes);
app.route('/api/attachments', attachmentRoutes);

// Healthz is intentionally unauthenticated (used by the CLI wizard + LB checks).
app.get('/healthz', (c) => c.json({ ok: true }));

// Workers Assets fallback: let the asset server serve the SPA.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
