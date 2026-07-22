import { createAuthStore, type AuthProfile, type BaseTokens } from "../oauth/store.js";

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

function isCodexTokens(value: unknown): value is CodexTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.accountId === undefined || typeof t.accountId === "string")
  );
}

const store = createAuthStore<CodexTokens>({
  filename: "codex-auth.json",
  isTokens: isCodexTokens,
});

export const codexAuthPath = store.authPath;
export const listCodexProfiles = store.listProfiles;
export const loadCodexProfile = store.loadProfile;
export const saveCodexProfile = store.saveProfile;
export const updateCodexTokens = store.updateTokens;
export const removeCodexProfile = store.removeProfile;
