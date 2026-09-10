import {
  openInBrowser,
  startOAuthLogin,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "@corbits/oauth-core";

import type { CallbackPageCopy } from "../callback-page.js";
import { saveCodexProfile } from "../../config/oauth-stores.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "./constants.js";
import { startCodexCallbackServer } from "./callback-server.js";
import { buildAuthorizeUrl, exchangeCode } from "./oauth.js";
import type { CodexTokens } from "./store.js";

export { openInBrowser };

export type CodexLoginHandle = OAuthLoginHandle<CodexTokens>;
export type StartCodexLoginOptions = StartOAuthLoginOptions & {
  home?: string;
  copy: CallbackPageCopy;
};

// Drive the loopback PKCE login for a Codex profile.
export async function startCodexLogin(
  opts: StartCodexLoginOptions,
): Promise<CodexLoginHandle> {
  const { home, copy, ...loginOpts } = opts;
  return startOAuthLogin(loginOpts, {
    startCallbackServer: (state) => startCodexCallbackServer(state, copy),
    buildAuthorizeUrl,
    exchangeCode,
    saveProfile: (profile) => saveCodexProfile(profile, home),
  });
}

// Metadata describing the Codex provider surface, used when projecting a logged
// in profile into the provider catalog.
export const codexProviderSurface = {
  baseURL: CODEX_BASE_URL,
  models: [...CODEX_DEFAULT_MODELS],
} as const;
