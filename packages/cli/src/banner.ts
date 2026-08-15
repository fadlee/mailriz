import pc from 'picocolors';

/**
 * ASCII banner + shared wizard chrome, styled after cloakmail-cli.
 */

// ANSI Shadow-style "MAILRIZ" (hand-rendered, actual box characters).
export const BANNER = `██████╗ ██╗      ██████╗ ██████╗ ██╗███████╗
██╔══██╗██║     ██╔═══██╗██╔══██╗██║╚══███╔╝
██████╔╝██║     ██║   ██║██████╔╝██║  ███╔╝
██╔══██╗██║     ██║   ██║██╔══██╗██║ ███╔╝
██║  ██║███████╗╚██████╔╝██║  ██║██║███████╗
╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚══════╝
            Self-hosted disposable email
`;

/** One-line separator for step headers. */
export function stepHeader(text: string): void {
  console.log('');
  console.log(pc.cyan(pc.bold(text)));
}

/** A small inline status row: `✔ message` (green) or `✗ message` (red). */
export function statusRow(ok: boolean, message: string): void {
  const icon = ok ? pc.green('✔') : pc.red('✗');
  console.log(`${icon} ${message}`);
}

/** Render the banner + tagline at wizard start. */
export function showBanner(): void {
  console.log(pc.cyan(BANNER));
}
