/**
 * The MailRiz mark, inlined rather than loaded from /favicon.svg so it paints
 * with the first render instead of after a second request — it sits on the
 * login screen, which is the first thing a cold visit shows.
 *
 * Kept identical to public/favicon.svg and the docs site's copy. If the mark
 * changes, all three change together.
 */
export function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      role="img"
      aria-label="MailRiz"
      className="shrink-0"
    >
      <rect width="72" height="72" rx="18" fill="#1d1e3a" />
      <path d="M19 53 L19 19" stroke="#6b74c8" strokeWidth="8" strokeLinecap="round" />
      <path d="M19 19 L40 40" stroke="#98a2e6" strokeWidth="8" strokeLinecap="round" />
      <path d="M40 40 L53 19" stroke="#cdd3f5" strokeWidth="8" strokeLinecap="round" />
      <circle cx="53" cy="53" r="4.5" fill="#ffffff" />
    </svg>
  );
}
