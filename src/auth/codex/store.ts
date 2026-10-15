import { type } from "arktype";
import type { AuthProfile } from "@corbits/oauth-core";
import type { CodexTokens } from "@corbits/codex-provider";

import { defineProviderAuthStore } from "../provider-auth-store.js";

// On-disk store for Codex OAuth profiles: a user may hold multiple
// subscriptions (personal, work, ...), so credentials are keyed by a
// user-chosen profile name within a single file.

export type { CodexTokens };

export type CodexProfile = AuthProfile<CodexTokens>;

// The package mapper leaves expiresAt unset when the token endpoint omits
// expires_in; disk profiles need a concrete expiry so the arktype guard can
// load them. 3600s matches the previous host mapper.
const DEFAULT_EXPIRES_IN_S = 3600;

export function withDefaultCodexExpiry(
  tokens: CodexTokens,
  now: number,
): CodexTokens {
  if (tokens.expiresAt !== undefined) return tokens;
  return { ...tokens, expiresAt: now + DEFAULT_EXPIRES_IN_S * 1000 };
}

export const CODEX_AUTH_FILENAME = "codex-auth.json";

export const createCodexAuthStore = defineProviderAuthStore<CodexTokens>({
  filename: CODEX_AUTH_FILENAME,
  tokensShape: type({
    access: "string",
    refresh: "string",
    expiresAt: "number",
    "accountId?": "string",
  }),
});
