/**
 * Shared unknown-throw coercion for the agent loop: an Error's message,
 * otherwise String(err). Consolidates the repeated inline
 * `err instanceof Error ? err.message : String(err)` expression.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
