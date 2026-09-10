import { type } from "arktype";
import type { AuthProfile } from "@corbits/oauth-core";
import type { CodexTokens } from "@corbits/codex-provider";

import { createAuthStore } from "../store.js";

// On-disk store for Codex OAuth profiles. A user may hold multiple Codex
// subscriptions (personal, work, ...), so credentials are keyed by a
// user-chosen profile name within a single file. The provider type is shared;
// the profile name is what differentiates instances throughout the app.

export type { CodexTokens };

export type CodexProfile = AuthProfile<CodexTokens>;

const CodexTokensShape = type({
  access: "string",
  refresh: "string",
  expiresAt: "number",
  "accountId?": "string",
});

function isCodexTokens(value: unknown): value is CodexTokens {
  return !(CodexTokensShape(value) instanceof type.errors);
}

// The package mapper leaves expiresAt unset when the token endpoint omits
// expires_in. Disk profiles must have a concrete expiry so the arktype guard
// can load them; 3600s matches the previous host mapper.
const DEFAULT_EXPIRES_IN_S = 3600;

export function withDefaultCodexExpiry(
  tokens: CodexTokens,
  now: number,
): CodexTokens {
  if (tokens.expiresAt !== undefined) return tokens;
  return { ...tokens, expiresAt: now + DEFAULT_EXPIRES_IN_S * 1000 };
}

export function createCodexAuthStore(settingsDirName: string) {
  return createAuthStore<CodexTokens>({
    filename: "codex-auth.json",
    settingsDirName,
    isTokens: isCodexTokens,
  });
}
