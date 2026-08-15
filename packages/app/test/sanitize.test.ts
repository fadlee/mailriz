import { describe, it, expect } from 'bun:test';
import { sanitizeHtml } from '../src/lib/sanitize';

describe('sanitizeHtml', () => {
  it('strips script tags entirely', () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(1)</script><p>bye</p>');
    expect(out).not.toContain('script');
    expect(out).toContain('hi');
    expect(out).toContain('bye');
  });

  it('removes on* event handlers', () => {
    const out = sanitizeHtml('<a href="https://x.com" onclick="steal()">x</a>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('href="https://x.com"');
  });

  it('blocks javascript: URLs', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<a');
  });

  it('blocks external images into data-blocked-src', () => {
    const out = sanitizeHtml('<img src="https://evil.com/t.png">');
    expect(out).not.toContain('<img src="https://evil.com/t.png"');
    expect(out).not.toContain(' src="https://evil.com/t.png"');
    expect(out).toContain('data-blocked-src="https://evil.com/t.png"');
  });

  it('allows data:image for src', () => {
    const out = sanitizeHtml('<img src="data:image/png;base64,AAAA">');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it('strips style url() and expression()', () => {
    const out = sanitizeHtml('<div style="background:url(javascript:alert(1));color:red">x</div>');
    expect(out).not.toContain('url(');
    expect(out).not.toContain('javascript');
    expect(out).toContain('color:red');
  });

  it('drops form/iframe/object/embed', () => {
    const out = sanitizeHtml('<form action="/submit"></form><iframe src="https://x"></iframe><object></object>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
  });

  it('escapes stray < in text', () => {
    const out = sanitizeHtml('a < b');
    expect(out).toContain('a &lt; b');
  });

  it('does not loop forever on malformed HTML (regression)', () => {
    // Input with '<' but no closing '>' used to infinite-loop the tokenizer.
    const out = sanitizeHtml('a < b < c');
    expect(out).toContain('a &lt; b &lt; c');
  });

  it('handles a bare "<" at end of input', () => {
    const out = sanitizeHtml('text <');
    expect(out).toBe('text &lt;');
  });
});
