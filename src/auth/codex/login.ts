import {
  buildAuthorizeUrl,
  openInBrowser,
  startOAuthLogin,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "@corbits/oauth-core";
import {
  codexOAuthConfig,
  exchangeCodexCode,
  type CodexTokens,
} from "@corbits/codex-provider";

import type { CallbackPageCopy } from "../callback-page.js";
import { saveCodexProfile } from "../../config/oauth-stores.js";
import { startCodexCallbackServer } from "./callback-server.js";
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
