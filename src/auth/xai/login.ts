import {
  exchangeXaiCode,
  xaiOAuthConfig,
  type XaiTokens,
} from "@corbits/xai-provider";
import type {
  OAuthLoginHandle,
  StartOAuthLoginOptions,
} from "@corbits/oauth-core";
import { startProviderLogin } from "../provider-login.js";

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
  return startProviderLogin<XaiTokens>(loginOpts, {
    oauthConfig: xaiOAuthConfig,
    startCallbackServer: (state) => startXaiCallbackServer(state, copy),
    exchangeCode: exchangeXaiCode,
    saveProfile: (profile) => saveXaiProfile(profile, home),
  });
}
