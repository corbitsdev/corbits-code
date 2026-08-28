import {
  startOAuthLogin,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "../oauth/login.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "./constants.js";
import { startXaiCallbackServer } from "./callback-server.js";
import { buildAuthorizeUrl, exchangeCode } from "./oauth.js";
import { saveXaiProfile, type XaiTokens } from "./store.js";

export type XaiLoginHandle = OAuthLoginHandle<XaiTokens>;
export type StartXaiLoginOptions = StartOAuthLoginOptions;

export async function startXaiLogin(opts: StartXaiLoginOptions): Promise<XaiLoginHandle> {
  return startOAuthLogin(opts, {
    startCallbackServer: startXaiCallbackServer,
    buildAuthorizeUrl,
    exchangeCode,
    saveProfile: saveXaiProfile,
  });
}

export const xaiProviderSurface = {
  baseURL: XAI_BASE_URL,
  models: [...XAI_DEFAULT_MODELS],
} as const;
