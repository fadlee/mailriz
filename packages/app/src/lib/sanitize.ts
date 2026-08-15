/**
 * Aggressive HTML sanitizer for email bodies.
 *
 * Strategy:
 * - Strip <script>, <style>, <form>, <iframe>, <object>, <embed>, <base>,
 *   <meta>, <link>, <title> entirely.
 * - Remove all on* attributes, javascript: URLs, and CSS url() / expression().
 * - Neutralize external <img src> into data-blocked-src (frontend lets the
 *   user reveal them on demand).
 * - Drop <style> content, then re-encode remaining text.
 *
 * Runs on the Worker (V8) — no DOM, so we do a regex/parser-light pass.
 * It is intentionally conservative: a lost style is acceptable, a leak is not.
 */

const DROP_TAGS = new Set([
  'script', 'style', 'form', 'iframe', 'object', 'embed', 'base',
  'meta', 'link', 'title', 'template',
]);

const ATTR_KEEP = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'align', 'color',
  'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan',
  'valign', 'face', 'size', 'target', 'rel', 'start', 'type', 'value',
  'style',
]);

const SCHEME_SAFE = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Sanitize a single attribute value (also strips dangerous CSS in style). */
function sanitizeAttr(name: string, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;

  if (name === 'style') {
    // Remove url(), expression(), @import, behavior, -moz-binding.
    // Note: [^;] (not [^)]) so nested parens like url(foo(1)) are consumed whole.
    const cleaned = v
      .replace(/url\s*\([^;]*\)/gi, 'none')
      .replace(/expression\s*\([^;]*\)/gi, 'none')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/behavior\s*:/gi, '')
      .replace(/-moz-binding\s*:/gi, '')
      .replace(/javascript\s*:/gi, '');
    return cleaned.trim() || null;
  }

  if (name === 'href' || name === 'src' || name === 'action') {
    const lower = v.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:')) {
      // Allow data: only for images (src), block otherwise.
      if (name === 'src' && lower.startsWith('data:image/')) return v;
      return null;
    }
    // Allow http(s)/mailto/tel and relative URLs.
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !SCHEME_SAFE.has(lower.split(':')[0] + ':')) return null;
    return v;
  }

  return v;
}

/**
 * Parse HTML with a lightweight tokenizer. Returns sanitized HTML.
 * External image <img src> is rewritten to data-blocked-src.
 */
export function sanitizeHtml(input: string): string {
  let out = '';
  let i = 0;
  const len = input.length;

  const readTag = (): { tag: string; raw: string } | null => {
    const start = i;
    // find '>'; if none exists, this is not a real tag (escape the '<').
    const j = input.indexOf('>', i);
    if (j === -1) {
      i = start + 1; // consume just the '<' so the loop always advances
      return null;
    }
    const raw = input.slice(start, j + 1);
    i = j + 1;
    const m = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(raw);
    if (!m) {
      i = start + 1; // not a valid tag — consume just the '<'
      return null;
    }
    return { tag: m[2]!.toLowerCase(), raw };
  };

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out += input.slice(i);
      break;
    }
    // Text before '<'
    out += input.slice(i, lt);
    i = lt;

    const tag = readTag();
    if (!tag) {
      // Not a valid tag — escape the '<' and continue.
      out += '&lt;';
      continue;
    }
    const { tag: t, raw } = tag;
    const isClose = raw.startsWith('</');

    if (DROP_TAGS.has(t)) {
      // Drop the element: if not a close tag, also skip until its closing tag.
      if (!isClose) {
        const closeRe = new RegExp(`<\\/\\s*${t}\\s*>`, 'i');
        const rest = input.slice(i);
        const m = rest.match(closeRe);
        if (m && m.index !== undefined) {
          i += m.index + m[0].length;
        }
      }
      continue;
    }

    // Build sanitized tag.
    if (isClose) {
      out += `</${t}>`;
      continue;
    }

    // Parse attributes.
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
    let attrs: string[] = [];
    let m2: RegExpExecArray | null;
    let blockedSrc: string | null = null;
    const seen = new Set<string>();
    while ((m2 = attrRe.exec(raw)) !== null) {
      const name = m2[1]!.toLowerCase();
      let value = m2[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (name.startsWith('on')) continue; // event handlers
      if (!ATTR_KEEP.has(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const safe = sanitizeAttr(name, value);
      if (safe === null) continue;
      if (name === 'src' && t === 'img' && !safe.startsWith('data:')) {
        blockedSrc = safe;
        continue; // replaced with data-blocked-src
      }
      attrs.push(`${name}="${escapeHtml(safe)}"`);
    }
    if (blockedSrc) {
      attrs.push(`data-blocked-src="${escapeHtml(blockedSrc)}"`);
    }

    const selfClose = /\/\s*>$/.test(raw) || t === 'img' || t === 'br' || t === 'hr' || t === 'input' || t === 'meta' || t === 'link';
    if (selfClose) {
      out += `<${t}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    } else {
      out += `<${t}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    }
  }

  return out;
}
