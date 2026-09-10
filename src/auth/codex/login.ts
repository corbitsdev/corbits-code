import {
  buildAuthorizeUrl,
  openInBrowser,
  startOAuthLogin,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "@corbits/oauth-core";
import {
  CODEX_BASE_URL,
  codexOAuthConfig,
  exchangeCodexCode,
  type CodexTokens,
} from "@corbits/codex-provider";

import type { CallbackPageCopy } from "../callback-page.js";
import { saveCodexProfile } from "../../config/oauth-stores.js";
import { startCodexCallbackServer } from "./callback-server.js";
import { CODEX_DEFAULT_MODELS } from "./constants.js";
import { withDefaultCodexExpiry } from "./store.js";

export { openInBrowser };

export type CodexLoginHandle = OAuthLoginHandle<CodexTokens>;
export type StartCodexLoginOptions = StartOAuthLoginOptions & {
  home?: string;
  copy: CallbackPageCopy;
};

export async function startCodexLogin(
  opts: StartCodexLoginOptions,
): Promise<CodexLoginHandle> {
  const { home, copy, ...loginOpts } = opts;
  return startOAuthLogin(loginOpts, {
    startCallbackServer: (state) => startCodexCallbackServer(state, copy),
    buildAuthorizeUrl: (pkce, state) =>
      buildAuthorizeUrl(codexOAuthConfig, pkce, state),
    exchangeCode: async (code, verifier, now) =>
      withDefaultCodexExpiry(await exchangeCodexCode(code, verifier, now), now),
    saveProfile: (profile) => saveCodexProfile(profile, home),
  });
}

export const codexProviderSurface = {
  baseURL: CODEX_BASE_URL,
  models: [...CODEX_DEFAULT_MODELS],
} as const;
