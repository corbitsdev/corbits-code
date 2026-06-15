import { CODEX_REFRESH_SKEW_MS } from "./constants.js";
import { refreshTokens } from "./oauth.js";
import { loadCodexProfile, updateCodexTokens, type CodexTokens } from "./store.js";

// Raised when a Codex profile cannot yield a usable access token: it is gone,
// or its refresh token has been revoked/expired. Carries the profile name so
// the TUI can name the affected profile in a re-login prompt. `reason`
// distinguishes "never authorized" from "refresh rejected" for messaging.
export class CodexAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";

  constructor(profile: string, reason: "missing" | "refresh-failed", message: string) {
    super(message);
    this.name = "CodexAuthError";
    this.profile = profile;
    this.reason = reason;
  }
}

export function isCodexTokenExpired(tokens: CodexTokens, now: number): boolean {
  return now >= tokens.expiresAt - CODEX_REFRESH_SKEW_MS;
}

// Resolve a valid access token for a Codex profile, refreshing transparently
// when the stored token is at or near expiry. The refreshed tokens are
// persisted so other sessions and a later run see the renewal. Throws
// CodexAuthError when the profile is unknown or the refresh is rejected, so
// callers can prompt for re-login rather than sending a dead credential.
export async function getValidCodexToken(
  name: string,
  now: number = Date.now(),
  home?: string,
): Promise<string> {
  const profile = await loadCodexProfile(name, home);
  if (profile === undefined) {
    throw new CodexAuthError(name, "missing", `Codex profile "${name}" is not authorized. Log in again.`);
  }
  if (!isCodexTokenExpired(profile.tokens, now)) {
    return profile.tokens.access;
  }
  let refreshed: CodexTokens;
  try {
    refreshed = await refreshTokens(profile.tokens.refresh, now);
  } catch (err) {
    throw new CodexAuthError(
      name,
      "refresh-failed",
      `Codex profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
    );
  }
  await updateCodexTokens(name, refreshed, home);
  return refreshed.access;
}
