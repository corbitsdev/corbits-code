// xAI login flow — see the shared factory in ./provider.ts.
import type { OAuthLoginHandle, StartOAuthLoginOptions } from "../oauth/login.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "./constants.js";
import { xaiAuth } from "./provider.js";
import type { XaiTokens } from "./provider.js";

export type XaiLoginHandle = OAuthLoginHandle<XaiTokens>;
export type StartXaiLoginOptions = StartOAuthLoginOptions;

export const startXaiLogin = xaiAuth.startLogin;

export const xaiProviderSurface = {
  baseURL: XAI_BASE_URL,
  models: [...XAI_DEFAULT_MODELS],
} as const;
