import {
  exchangeCodexCode,
  codexOAuthConfig,
  type CodexTokens,
} from "@corbits/codex-provider";
import {
  openInBrowser,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "@corbits/oauth-core";
import { startProviderLogin } from "../provider-login.js";

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
  return startProviderLogin<CodexTokens>(loginOpts, {
    oauthConfig: codexOAuthConfig,
    startCallbackServer: (state) => startCodexCallbackServer(state, copy),
    // The mapper leaves expiresAt unset when the response omits expires_in.
    exchangeCode: async (code, verifier, now) =>
      withDefaultCodexExpiry(await exchangeCodexCode(code, verifier, now), now),
    saveProfile: (profile) => saveCodexProfile(profile, home),
  });
}
