import { type } from "arktype";
import type { AuthProfile } from "@corbits/oauth-core";

import { createAuthStore, type BaseTokens } from "../store.js";

// On-disk store for Codex OAuth profiles. A user may hold multiple Codex
// subscriptions (personal, work, ...), so credentials are keyed by a
// user-chosen profile name within a single file. The provider type is shared;
// the profile name is what differentiates instances throughout the app.

export type CodexTokens = BaseTokens & {
  // ChatGPT account id extracted from the id_token, required as the
  // `chatgpt-account-id` header on every Codex inference request.
  accountId?: string;
};

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

export function createCodexAuthStore(settingsDirName: string) {
  return createAuthStore<CodexTokens>({
    filename: "codex-auth.json",
    settingsDirName,
    isTokens: isCodexTokens,
  });
}
