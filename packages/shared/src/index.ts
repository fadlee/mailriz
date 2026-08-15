/**
 * @mailriz/shared — types + constants shared between the Worker,
 * the dashboard, and the CLI.
 */

export const SNIPPET_LENGTH = 120;
export const ALIAS_LOCAL_PART_RE = /^[a-z0-9._-]{1,64}$/;
export const VAULT_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export type AuthMode = 'access' | 'session';

export interface MeResponse {
  email: string;
  mode: AuthMode;
  domain: string;
}

export interface Alias {
  id: string;
  local_part: string;
  domain: string;
  label: string;
  note: string;
  is_enabled: number; // 0 | 1
  /** 1 when the catch-all created this on first delivery. */
  is_auto?: number;
  created_at: number;
  email_count: number;
  last_received_at: number | null;
}

export interface CreateAliasInput {
  mode: 'random' | 'custom';
  customPrefix?: string;
  label?: string;
  note?: string;
}

export interface UpdateAliasInput {
  label?: string;
  note?: string;
  is_enabled?: 0 | 1;
}

export type EmailView = 'inbox' | 'starred' | 'archived' | 'trash';

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface EmailSummary {
  id: string;
  alias_id: string;
  from_address: string;
  from_name: string;
  subject: string;
  snippet: string;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_trashed: number;
  has_attachments: number;
  size_bytes: number;
  received_at: number;
  labels: Label[];
}

export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface EmailDetail extends EmailSummary {
  to_address: string;
  message_id: string | null;
  body_text: string;
  html_r2_key?: string | null;
  /** Remote images in the body; cid:/data: sources don't count. */
  blocked_images?: number;
  attachments: Attachment[];
}

export interface EmailListResponse {
  emails: EmailSummary[];
  next_cursor: string | null;
}

export interface UpdatesResponse {
  updates: EmailSummary[];
}

export interface UpdateEmailInput {
  is_read?: 0 | 1;
  is_starred?: 0 | 1;
  is_archived?: 0 | 1;
  is_trashed?: 0 | 1;
  label_ids?: string[];
}

export type BulkAction =
  | 'read'
  | 'unread'
  | 'archive'
  | 'unarchive'
  | 'trash'
  | 'untrash'
  | 'delete';

export interface BulkInput {
  ids: string[];
  action: BulkAction;
}

/** Cut a plain-text body into a display snippet. */
export function makeSnippet(bodyText: string, length = SNIPPET_LENGTH): string {
  const collapsed = bodyText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= length) return collapsed;
  return collapsed.slice(0, length).trimEnd() + '…';
}
