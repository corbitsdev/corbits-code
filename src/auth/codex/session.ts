import { createTokenSession } from "../oauth/session.js";
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

// A usable access token plus the account id that must ride alongside it in the
// chatgpt-account-id header. Returned together so callers need a single load,
// not a token fetch followed by a separate profile read (which could observe a
// token and account id from two different points in a concurrent refresh).
export interface CodexAccess {
  access: string;
  accountId?: string | undefined;
}

const session = createTokenSession<CodexTokens, CodexAccess>({
  skewMs: CODEX_REFRESH_SKEW_MS,
  loadProfile: loadCodexProfile,
  updateTokens: updateCodexTokens,
  refreshTokens,
  toAccess: (tokens) => ({ access: tokens.access, accountId: tokens.accountId }),
  // The refresh response rarely re-issues an id_token, so carry the account id
  // forward from the prior tokens when the refresh did not supply one.
  mergeRefreshed: (refreshed, previous) =>
    refreshed.accountId === undefined && previous.accountId !== undefined
      ? { ...refreshed, accountId: previous.accountId }
      : refreshed,
  missingError: (name) =>
    new CodexAuthError(name, "missing", `Codex profile "${name}" is not authorized. Log in again.`),
  refreshFailedError: (name, err) =>
    new CodexAuthError(
      name,
      "refresh-failed",
      `Codex profile "${name}" could not be refreshed (${err instanceof Error ? err.message : String(err)}). Log in again.`,
    ),
});

export const isCodexTokenExpired = session.isExpired;
export const getValidCodexToken = session.getValidToken;

export async function refreshStagedCodexTokens(
  tokens: CodexTokens,
  now: number = Date.now(),
): Promise<CodexTokens> {
  if (!isCodexTokenExpired(tokens, now)) return tokens;
  const refreshed = await refreshTokens(tokens.refresh, now);
  Object.assign(tokens, refreshed);
  return tokens;
}
