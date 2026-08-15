import { describe, it, expect } from 'bun:test';
import { stripActiveContent } from '../src/lib/sanitize';

/**
 * The body is rendered as-is, so this pass removes only what can execute.
 *
 * Everything about how a message *looks* has to survive: an email's layout is
 * carried by <style> blocks, table markup and inline styles, and the old
 * allowlist sanitizer destroyed all three. Remote images are withheld by the
 * response CSP instead of by rewriting HTML.
 */

describe('stripActiveContent', () => {
  describe('removes what can execute', () => {
    it('strips script tags and their contents', () => {
      const out = stripActiveContent('<p>hi</p><script>alert(1)</script><p>bye</p>');
      expect(out).not.toContain('<script');
      expect(out).not.toContain('alert(1)');
      expect(out).toContain('<p>hi</p>');
      expect(out).toContain('<p>bye</p>');
    });

    it('strips a script block that is never closed', () => {
      const out = stripActiveContent('<p>hi</p><script>alert(1)');
      expect(out).not.toContain('alert(1)');
      expect(out).toContain('<p>hi</p>');
    });

    it('removes on* handlers in every quoting style', () => {
      const out = stripActiveContent(
        `<div onclick="a()" onmouseover='b()' onfocus=c()>x</div>`
      );
      expect(out).not.toMatch(/onclick|onmouseover|onfocus/i);
      expect(out).toContain('<div');
      expect(out).toContain('x</div>');
    });

    it('removes javascript: and vbscript: URLs', () => {
      const out = stripActiveContent(
        `<a href="javascript:alert(1)">a</a><img src='vbscript:x'><a href=javascript:y>b</a>`
      );
      expect(out).not.toMatch(/javascript:|vbscript:/i);
    });
  });

  describe('leaves presentation untouched', () => {
    it('keeps <style> blocks, which carry the entire layout', () => {
      const css = '<style>.card{padding:24px;background:#fff}</style>';
      expect(stripActiveContent(`${css}<div class="card">x</div>`)).toContain(css);
    });

    it('keeps inline styles including url() backgrounds', () => {
      const html = `<td style="background:url('https://cdn.example/bg.png');padding:8px">x</td>`;
      expect(stripActiveContent(html)).toBe(html);
    });

    it('keeps table markup and presentational attributes', () => {
      const html =
        '<table cellpadding="0" cellspacing="0" width="600" bgcolor="#f4f2ec">' +
        '<tr><td align="center" valign="top">x</td></tr></table>';
      expect(stripActiveContent(html)).toBe(html);
    });

    it('keeps image sources as written — blocking is the CSP\'s job', () => {
      const html = '<img src="https://cdn.example/logo.png" width="120">';
      expect(stripActiveContent(html)).toBe(html);
    });

    it('keeps cid: and data: image sources', () => {
      const html = '<img src="cid:logo@mail"><img src="data:image/png;base64,AAA">';
      expect(stripActiveContent(html)).toBe(html);
    });

    it('keeps tags the old allowlist dropped', () => {
      const html = '<video controls></video><svg><circle r="5"/></svg><custom-tag>x</custom-tag>';
      expect(stripActiveContent(html)).toBe(html);
    });

    it('leaves text and entities alone', () => {
      const html = '<p>5 &lt; 6 &amp; 7 &gt; 6</p>';
      expect(stripActiveContent(html)).toBe(html);
    });
  });

  describe('malformed input', () => {
    it('returns empty for empty input', () => {
      expect(stripActiveContent('')).toBe('');
    });

    it('does not hang on a bare "<" at end of input (regression)', () => {
      expect(stripActiveContent('<p>hi</p><')).toContain('<p>hi</p>');
    });

    it('does not hang on an unterminated tag (regression)', () => {
      const out = stripActiveContent('<div class="x onclick=');
      expect(typeof out).toBe('string');
    });
  });
});
