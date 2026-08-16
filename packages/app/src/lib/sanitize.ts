/**
 * Strip active content from an email body, and nothing else.
 *
 * The body is rendered as-is: the layout an email was designed with is the
 * point, so markup, tags, `<style>` blocks and inline styles are all left
 * untouched. Blocking remote images is handled by the Content-Security-Policy
 * on the response, not by rewriting the HTML — see routes/emails.ts.
 *
 * What is removed here is only what could execute:
 *
 * - `<script>` blocks, including their contents
 * - `on*` event handler attributes
 * - `javascript:` / `vbscript:` URLs in href/src/action
 *
 * None of that affects how a message looks, so removing it costs no fidelity.
 *
 * **This is not a security boundary.** It runs on the Worker (V8) with no DOM,
 * so it is regex over HTML, and HTML offers more ways to write a handler than
 * a regex can enumerate — `<img/onerror=…>` with a slash instead of a space,
 * an entity-encoded scheme, a tab inside `javascript:`, `srcdoc`, and
 * `<meta http-equiv=refresh>` all survive it. Verified, not assumed.
 *
 * What actually stops scripts is the CSP on the response (`default-src 'none'`
 * plus `sandbox`) and the sandboxed iframe in the reading pane. Neither of
 * those depends on this function being thorough, and neither should ever be
 * relaxed on the strength of it.
 */

/** `<script …>…</script>`, plus an unterminated trailing one. */
const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi;

/** `onclick=…` in single, double, or unquoted form. */
const EVENT_ATTR = /\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/** href/src/action pointing at a script URL, quoted or bare. */
const SCRIPT_URL_ATTR =
  /\s(href|src|action|formaction)\s*=\s*(?:"\s*(?:javascript|vbscript)\s*:[^"]*"|'\s*(?:javascript|vbscript)\s*:[^']*'|(?:javascript|vbscript)\s*:[^\s>]*)/gi;

export function stripActiveContent(input: string): string {
  if (!input) return '';
  return input
    .replace(SCRIPT_BLOCK, '')
    .replace(EVENT_ATTR, '')
    .replace(SCRIPT_URL_ATTR, '');
}

/**
 * @deprecated Kept so existing callers keep compiling; the aggressive
 * allowlist sanitizer it used to name is gone.
 */
export const sanitizeHtml = stripActiveContent;
