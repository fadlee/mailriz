export interface Env {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  ATTACHMENTS_BUCKET: R2Bucket;
  HTML_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Optional override for the Access certs endpoint (defaults to https://<team>/cdn-cgi/access/certs). */
  ACCESS_CERTS_URL?: string;
  TRASH_RETENTION_DAYS?: string;
  AUTH_MODE?: string;
  /**
   * Session credentials, both Worker **secrets** rather than vars.
   *
   * SESSION_PASSWORD_HASH is `pbkdf2:<iterations>:<salt>:<hash>`; the signing
   * key is separate so that reading the hash does not let anyone mint a
   * session. See packages/shared/src/credentials.ts.
   */
  SESSION_PASSWORD_HASH?: string;
  SESSION_SIGNING_KEY?: string;
  /** Workers Rate Limiting binding guarding POST /api/login. */
  LOGIN_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  DASHBOARD_HOSTNAME?: string;
  /**
   * The domain mail actually arrives on — the zone apex that Email Routing's
   * catch-all serves. Distinct from DASHBOARD_HOSTNAME, which is the
   * subdomain the UI is served from and receives no mail.
   */
  MAIL_DOMAIN?: string;
  /** Live-update stream timings, in ms; see routes/updates.ts. */
  UPDATES_POLL_MS?: string;
  UPDATES_PING_MS?: string;
  UPDATES_CONNECTION_MS?: string;
}

export interface AuthUser {
  email: string;
  mode: 'access' | 'session';
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    env: Env;
  };
};
