// Codex login flow — see the shared factory in ./provider.ts.
import { openInBrowser } from "../oauth/browser.js";
import type { OAuthLoginHandle, StartOAuthLoginOptions } from "../oauth/login.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "./constants.js";
import { codexAuth } from "./provider.js";
import type { CodexTokens } from "./provider.js";

export { openInBrowser };

export type CodexLoginHandle = OAuthLoginHandle<CodexTokens>;
export type StartCodexLoginOptions = StartOAuthLoginOptions;

export const startCodexLogin = codexAuth.startLogin;

// Metadata describing the Codex provider surface, used when projecting a logged
// in profile into the provider catalog.
export const codexProviderSurface = {
  baseURL: CODEX_BASE_URL,
  models: [...CODEX_DEFAULT_MODELS],
} as const;
