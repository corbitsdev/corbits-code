import { openInBrowser } from "../oauth/browser.js";
import {
  startOAuthLogin,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "../oauth/login.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "./constants.js";
import { startCodexCallbackServer } from "./callback-server.js";
import { buildAuthorizeUrl, exchangeCode } from "./oauth.js";
import { saveCodexProfile, type CodexTokens } from "./store.js";

export { openInBrowser };

export type CodexLoginHandle = OAuthLoginHandle<CodexTokens>;
export type StartCodexLoginOptions = StartOAuthLoginOptions;

// Drive the loopback PKCE login for a Codex profile.
export async function startCodexLogin(opts: StartCodexLoginOptions): Promise<CodexLoginHandle> {
  return startOAuthLogin(opts, {
    startCallbackServer: startCodexCallbackServer,
    buildAuthorizeUrl,
    exchangeCode,
    saveProfile: saveCodexProfile,
  });
}

// Metadata describing the Codex provider surface, used when projecting a logged
// in profile into the provider catalog.
export const codexProviderSurface = {
  baseURL: CODEX_BASE_URL,
  models: [...CODEX_DEFAULT_MODELS],
} as const;
