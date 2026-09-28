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

// Sibling provider packages may still ship a distinct @corbits/oauth-core
// copy, so `instanceof` against this host's class identity is not reliable.
export type OAuthTokenEndpointFailure = Error & {
  status: number;
  detail: string;
};

export function isOAuthTokenEndpointError(
  err: unknown,
): err is OAuthTokenEndpointFailure {
  if (!(err instanceof Error) || err.name !== "OAuthTokenEndpointError")
    return false;
  if (!("status" in err) || typeof err.status !== "number") return false;
  return "detail" in err && typeof err.detail === "string";
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
  if (typeof error.stack === "string")
    Object.defineProperty(error, "stack", {
      configurable: true,
      value: sanitizeDiagnosticText(error.stack, [refreshToken]),
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
