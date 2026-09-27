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
  if (!(error instanceof Error))
    return new Error(sanitizeDiagnosticText(String(error), [refreshToken]));

  Object.defineProperty(error, "message", {
    configurable: true,
    value: sanitizeDiagnosticText(error.message, [refreshToken]),
  });
  if ("detail" in error && typeof error.detail === "string")
    Object.defineProperty(error, "detail", {
      configurable: true,
      value: sanitizeDiagnosticText(error.detail, [refreshToken]),
    });
  if (error.cause !== undefined)
    Object.defineProperty(error, "cause", {
      configurable: true,
      value: sanitizedRefreshFailure(error.cause, refreshToken),
    });
  return error;
}
