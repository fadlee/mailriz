import PostalMime from 'postal-mime';
import { ulid } from 'ulid';
import { Env } from './types';
import { makeSnippet, ALIAS_LOCAL_PART_RE } from '@mailriz/shared';
import { stripActiveContent } from './lib/sanitize';

/**
 * Inbound email handler — called by Cloudflare Email Routing.
 *
 * Flow:
 *  1. Resolve the alias from message.to (local_part + domain), creating it
 *     on first delivery for any address on MAIL_DOMAIN (catch-all).
 *  2. Reject disabled addresses, other domains, and bursts beyond the daily
 *     auto-create budget at SMTP level (spam backpressure).
 *  3. Store raw .eml in R2.
 *  4. Parse with postal-mime; store attachments in R2.
 *  5. Sanitize HTML → R2 (html bucket), keep body_text + snippet in D1.
 *  6. Insert row into D1; FTS triggers keep emails_fts in sync.
 */

export interface EmailMessageLike {
  to: string;
  from: string;
  headers: Headers;
  raw: ReadableStream | ArrayBuffer;
  setReject(reason: string): void;
  forward(addr: string): Promise<void>;
  reply(msg: string): Promise<void>;
}

const MAX_TEXT_LENGTH = 200_000; // safety cap for body_text in D1

/** Crude HTML → plain text for snippet/body when no text part exists. */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a ReadableStream (or pass through ArrayBuffer) into an ArrayBuffer. */
async function toArrayBuffer(raw: ReadableStream | ArrayBuffer): Promise<ArrayBuffer> {
  if (raw instanceof ArrayBuffer) return raw;
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/**
 * Count <img> tags pointing at a remote URL. Drives the "show images" prompt,
 * so it is only shown for mail that actually reaches off-host; cid: and data:
 * sources render immediately and don't count.
 */
function countRemoteImages(html: string): number {
  const matches = html.match(/<img\b[^>]*\bsrc\s*=\s*(?:"|')?\s*https?:/gi);
  return matches ? matches.length : 0;
}

interface StoredAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
  /** Content-ID without the angle brackets, for resolving src="cid:…". */
  contentId: string;
}

interface AliasRow {
  id: string;
  local_part: string;
  domain: string;
  is_enabled: number;
}

/** How many addresses the catch-all may materialise in a rolling day. */
const AUTO_ALIAS_DAILY_LIMIT = 50;

function findAlias(env: Env, localPart: string, domain: string): Promise<AliasRow | null> {
  return env.DB.prepare(
    'SELECT id, local_part, domain, is_enabled FROM aliases WHERE local_part = ?1 AND domain = ?2'
  ).bind(localPart, domain).first<AliasRow>();
}

/**
 * Whether to refuse an address that has no alias yet — returns the SMTP
 * rejection reason, or null to accept and create one.
 *
 * The catch-all only covers our own mail domain, only syntactically valid
 * local parts, and only up to a daily budget: Email Routing hands us every
 * address a spammer cares to guess, and each one would otherwise become a
 * permanent alias row.
 */
async function catchAllRefusal(env: Env, localPart: string, domain: string): Promise<string | null> {
  const mailDomain = (env.MAIL_DOMAIN || '').toLowerCase();
  if (!mailDomain || domain !== mailDomain) return 'Address not found';
  if (!ALIAS_LOCAL_PART_RE.test(localPart)) return 'Address not found';

  const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM aliases WHERE is_auto = 1 AND created_at > ?1'
  ).bind(since).first<{ n: number }>();

  if ((row?.n ?? 0) >= AUTO_ALIAS_DAILY_LIMIT) {
    // Temporary failure: legitimate senders retry, so a burst of guessed
    // addresses doesn't permanently lose real mail.
    return 'Too many new addresses today, try again later';
  }
  return null;
}

/** Materialise an alias for an address seen for the first time. */
async function createAutoAlias(env: Env, localPart: string, domain: string): Promise<AliasRow | null> {
  const id = ulid();
  try {
    await env.DB.prepare(
      `INSERT INTO aliases (id, user_id, local_part, domain, label, note, is_auto)
       VALUES (?1, ?2, ?3, ?4, '', '', 1)`
    ).bind(id, env.ADMIN_EMAIL || '', localPart, domain).run();
    return { id, local_part: localPart, domain, is_enabled: 1 };
  } catch {
    // Two messages to the same new address can race on UNIQUE(local_part,
    // domain); whichever lost simply reads the winner's row.
    return findAlias(env, localPart, domain);
  }
}

export async function emailHandler(message: EmailMessageLike, env: Env): Promise<void> {
  // 1. Parse recipient.
  let toAddr = message.to || '';
  let toLocal = '';
  let toDomain = '';
  const lt = toAddr.indexOf('@');
  if (lt !== -1) {
    toLocal = toAddr.slice(0, lt).trim().toLowerCase();
    toDomain = toAddr.slice(lt + 1).trim().toLowerCase();
  }

  // Subaddressing: news+netflix@ delivers to the alias `news`, rather than
  // minting a separate alias per tag.
  const plus = toLocal.indexOf('+');
  const baseLocal = plus === -1 ? toLocal : toLocal.slice(0, plus);

  // 2. Resolve the alias, creating it on first delivery if this is a new
  //    address on our own mail domain — the catch-all promise.
  let alias = await findAlias(env, baseLocal, toDomain);

  if (alias && !alias.is_enabled) {
    // Explicitly disabled by the owner: stay rejected, and do not resurrect it.
    message.setReject('Address not found');
    return;
  }

  if (!alias) {
    const reason = await catchAllRefusal(env, baseLocal, toDomain);
    if (reason) {
      message.setReject(reason);
      return;
    }
    alias = await createAutoAlias(env, baseLocal, toDomain);
    if (!alias) {
      message.setReject('Address not found');
      return;
    }
  }

  const id = ulid();
  const rawKey = `${alias.id}/${id}.eml`;
  const htmlKey = `${alias.id}/${id}.html`;

  try {
    // 3. Collect the raw stream, store it in R2 first (never lose mail).
    const rawBuffer = await toArrayBuffer(message.raw);
    await env.RAW_BUCKET.put(rawKey, rawBuffer);

    // 4. Parse with postal-mime.
    const parser = new PostalMime();
    const parsed = await parser.parse(rawBuffer);

    const fromAddress = (parsed.from?.address || '').toLowerCase();
    const fromName = parsed.from?.name || '';
    const subject = (parsed.subject || '').trim().slice(0, 500);
    const bodyText = (parsed.text || stripHtmlToText(parsed.html || '')).slice(0, MAX_TEXT_LENGTH);
    const bodyHtml = parsed.html || '';

    // 5. Sanitize + store HTML (R2), keep body_text in D1.
    let htmlKeyActual: string | null = null;
    let blockedImages = 0;
    if (bodyHtml) {
      // Stored as the sender wrote it, minus anything executable. Remote
      // images are withheld by the CSP when it is served, not by editing it.
      const body = stripActiveContent(bodyHtml);
      if (body) {
        blockedImages = countRemoteImages(body);
        await env.HTML_BUCKET.put(htmlKey, body);
        htmlKeyActual = htmlKey;
      }
    }

    const snippet = makeSnippet(bodyText);
    const receivedAt = Math.floor(Date.now() / 1000);
    const sizeBytes = rawBuffer.byteLength;

    // Attachments.
    const atts: StoredAttachment[] = (parsed.attachments || []).map((a) => {
      const content = a.content;
      const size = typeof content === 'string'
        ? new TextEncoder().encode(content).byteLength
        : (content?.byteLength || 0);
      // postal-mime reports it as `<abc@host>`; store the bare id.
      const rawCid = (a as { contentId?: string }).contentId || '';
      return {
        id: ulid(),
        filename: a.filename || 'attachment',
        contentType: a.mimeType || 'application/octet-stream',
        size,
        r2Key: '',
        contentId: rawCid.replace(/^<|>$/g, '').trim().toLowerCase(),
      };
    });

    const hasAttachments = atts.length > 0 ? 1 : 0;

    // Store attachments to R2.
    for (let i = 0; i < atts.length; i++) {
      const a = atts[i]!;
      const key = `${alias.id}/${id}/att-${i}-${a.id}`;
      const data = parsed.attachments?.[i];
      if (data && data.content) {
        await env.ATTACHMENTS_BUCKET.put(key, data.content);
      }
      a.r2Key = key;
    }

    // 6. Insert into D1.
    await env.DB.prepare(
      `INSERT INTO emails
        (id, alias_id, message_id, from_address, from_name, to_address, subject,
         body_text, snippet, raw_r2_key, html_r2_key, has_attachments, size_bytes, received_at,
         blocked_images)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    )
      .bind(
        id, alias.id,
        parsed.messageId || null,
        fromAddress, fromName, toAddr, subject,
        bodyText, snippet, rawKey, htmlKeyActual,
        hasAttachments, sizeBytes, receivedAt,
        blockedImages
      )
      .run();

    for (const a of atts) {
      await env.DB.prepare(
        'INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, r2_key, content_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
      ).bind(a.id, id, a.filename, a.contentType, a.size, a.r2Key, a.contentId).run();
    }
  } catch (err) {
    console.error('email handler error', err);
    // If we already stored the raw, keep it; don't lose mail.
    throw err;
  }
}

export default {
  email: emailHandler,
};
