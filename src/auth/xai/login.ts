import {
  buildAuthorizeUrl,
  startOAuthLogin,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "@corbits/oauth-core";
import {
  exchangeXaiCode,
  XAI_DEFAULT_MODELS,
  XAI_OAUTH_PROXY_BASE_URL,
  xaiOAuthConfig,
  type XaiTokens,
} from "@corbits/xai-provider";

import type { CallbackPageCopy } from "../callback-page.js";
import { saveXaiProfile } from "../../config/oauth-stores.js";
import { startXaiCallbackServer } from "./callback-server.js";

export type XaiLoginHandle = OAuthLoginHandle<XaiTokens>;
export type StartXaiLoginOptions = StartOAuthLoginOptions & {
  home?: string;
  copy: CallbackPageCopy;
};

export async function startXaiLogin(
  opts: StartXaiLoginOptions,
): Promise<XaiLoginHandle> {
  const { home, copy, ...loginOpts } = opts;
  return startOAuthLogin(loginOpts, {
    startCallbackServer: (state) => startXaiCallbackServer(state, copy),
    buildAuthorizeUrl: (pkce, state) =>
      buildAuthorizeUrl(xaiOAuthConfig, pkce, state),
    exchangeCode: exchangeXaiCode,
    saveProfile: (profile) => saveXaiProfile(profile, home),
  });
}

export const xaiProviderSurface = {
  baseURL: XAI_OAUTH_PROXY_BASE_URL,
  models: [...XAI_DEFAULT_MODELS],
} as const;
