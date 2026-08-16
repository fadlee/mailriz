/**
 * Where the Cloudflare token for an existing install comes from.
 *
 * `update` used to advertise "same one you used for setup" and then reject a
 * blank line — nothing was ever saved to reuse, and the placeholder was only
 * grey hint text, never a default. These are the pure decisions behind the
 * prompt, kept apart from it so they can be tested: cli.ts dispatches a
 * command on import and can't be pulled into a test.
 */

/** Shortest thing that could plausibly be a Cloudflare token. */
const MIN_LENGTH = 20;

export interface TokenSources {
  /** Saved to config during setup, only with the operator's consent. */
  stored?: string;
  /** $CLOUDFLARE_API_TOKEN. */
  env?: string;
}

/** The token to use when the operator submits `typed` (possibly empty). */
export function resolveToken(typed: string, sources: TokenSources): string {
  return typed.trim() || sources.stored || sources.env || '';
}

/** Whether pressing Enter on an empty prompt can work at all. */
export function hasFallback(sources: TokenSources): boolean {
  return Boolean(sources.stored || sources.env);
}

/** Grey text under the prompt, naming what Enter would actually do. */
export function sourceHint(sources: TokenSources): string {
  if (sources.stored) return 'Enter to use the saved token';
  if (sources.env) return 'Enter to use $CLOUDFLARE_API_TOKEN';
  return 'paste your token';
}

/** Validation message, or undefined when the input is acceptable. */
export function validateToken(value: string, sources: TokenSources): string | undefined {
  const typed = value.trim();
  if (typed) return typed.length >= MIN_LENGTH ? undefined : 'Token looks too short';
  // Empty is only an error when there's nothing to fall back to — which is
  // exactly what the old prompt got wrong.
  return hasFallback(sources) ? undefined : 'No saved token — paste one';
}
