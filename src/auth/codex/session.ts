// Codex token session — see the shared factory in ./provider.ts.
//
// Raised when a Codex profile cannot yield a usable access token: it is gone,
// or its refresh token has been revoked/expired. Carries the profile name so
// the TUI can name the affected profile in a re-login prompt. `reason`
// distinguishes "never authorized" from "refresh rejected" for messaging.
import { codexAuth } from "./provider.js";

export const CodexAuthError = codexAuth.AuthError;
export type CodexAuthError = InstanceType<typeof CodexAuthError>;

export type { CodexAccess } from "./provider.js";

export const isCodexTokenExpired = codexAuth.session.isExpired;
export const getValidCodexToken = codexAuth.session.getValidToken;
export const refreshStagedCodexTokens = codexAuth.refreshStaged;
