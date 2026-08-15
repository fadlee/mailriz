export interface Env {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  ATTACHMENTS_BUCKET: R2Bucket;
  HTML_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TRASH_RETENTION_DAYS?: string;
  AUTH_MODE?: string;
  SESSION_PASSWORD_HASH?: string;
  DASHBOARD_HOSTNAME?: string;
  /**
   * The domain mail actually arrives on — the zone apex that Email Routing's
   * catch-all serves. Distinct from DASHBOARD_HOSTNAME, which is the
   * subdomain the UI is served from and receives no mail.
   */
  MAIL_DOMAIN?: string;
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
