import { sanitizeDiagnosticText } from "../diagnostic-sanitize.js";

export function replaceMutableTokens<TTokens extends object>(
  target: TTokens,
  source: TTokens,
): void {
  const replacement = { ...source };
  const mutable = target as Record<string, unknown>;
  for (const key of Object.keys(mutable)) Reflect.deleteProperty(mutable, key);
  Object.assign(target, replacement);
}

export function sanitizedRefreshFailure(
  error: unknown,
  refreshToken: string,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(sanitizeDiagnosticText(message, [refreshToken]));
}
