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
 * It is defence in depth: the CSP already denies scripts, and the reading pane
 * frames the body in a sandboxed iframe. This is the layer that still holds if
 * one of those is ever misconfigured.
 *
 * Runs on the Worker (V8) — no DOM, so this is a regex pass rather than a
 * parse. It is deliberately narrow: a parser-light pass can be fooled into
 * *keeping* something it should have dropped, which is why it is not the only
 * defence.
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
