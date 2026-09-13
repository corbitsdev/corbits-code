// Codex (ChatGPT subscription) OAuth: PKCE login, named-profile storage, and
// transparent token refresh. The provider surfaces through the standard
// provider catalog; profiles are keyed by user-chosen name so multiple Codex
// subscriptions can coexist.

export {
  CODEX_BASE_URL,
  CODEX_DEFAULT_MODELS,
  CODEX_REDIRECT_URI,
} from "./constants.js";
export type { CodexProfile, CodexTokens } from "./store.js";
export {
  listCodexProfiles,
  loadCodexProfile,
  removeCodexProfile,
  saveCodexProfile,
} from "../../config/oauth-stores.js";
export {
  getValidCodexToken,
  isCodexTokenExpired,
  CodexAuthError,
} from "./session.js";
export {
  startCodexLogin,
  openInBrowser,
  type CodexLoginHandle,
  type StartCodexLoginOptions,
} from "./login.js";
