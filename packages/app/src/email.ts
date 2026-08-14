import PostalMime from 'postal-mime';
import { ulid } from 'ulid';
import { Env } from './types';
import { makeSnippet } from '@mailvault/shared';
import { sanitizeHtml } from './lib/sanitize';

/**
 * Inbound email handler — called by Cloudflare Email Routing.
 *
 * Flow:
 *  1. Resolve the alias from message.to (local_part + domain).
 *  2. Reject unknown/disabled addresses at SMTP level (spam backpressure).
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

interface StoredAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  r2Key: string;
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

  // 2. Look up alias.
  const alias = await env.DB.prepare(
    'SELECT id, local_part, domain, is_enabled FROM aliases WHERE local_part = ?1 AND domain = ?2'
  ).bind(toLocal, toDomain).first<{ id: string; local_part: string; domain: string; is_enabled: number }>();

  if (!alias || !alias.is_enabled) {
    message.setReject('Address not found');
    return;
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
    if (bodyHtml) {
      const sanitized = sanitizeHtml(bodyHtml);
      if (sanitized) {
        await env.HTML_BUCKET.put(htmlKey, sanitized);
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
      return {
        id: ulid(),
        filename: a.filename || 'attachment',
        contentType: a.mimeType || 'application/octet-stream',
        size,
        r2Key: '',
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
         body_text, snippet, raw_r2_key, html_r2_key, has_attachments, size_bytes, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    )
      .bind(
        id, alias.id,
        parsed.messageId || null,
        fromAddress, fromName, toAddr, subject,
        bodyText, snippet, rawKey, htmlKeyActual,
        hasAttachments, sizeBytes, receivedAt
      )
      .run();

    for (const a of atts) {
      await env.DB.prepare(
        'INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, r2_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(a.id, id, a.filename, a.contentType, a.size, a.r2Key).run();
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
