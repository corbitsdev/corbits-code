import { type } from "arktype";
import type { AuthProfile } from "@corbits/oauth-core";
import type { XaiTokens } from "@corbits/xai-provider";

import { defineProviderAuthStore } from "../provider-auth-store.js";

export type { XaiTokens };

export type XaiProfile = AuthProfile<XaiTokens>;

export const XAI_AUTH_FILENAME = "xai-auth.json";

export const createXaiAuthStore = defineProviderAuthStore<XaiTokens>({
  filename: XAI_AUTH_FILENAME,
  tokensShape: type({
    access: "string",
    refresh: "string",
    expiresAt: "number",
    "idToken?": "string",
  }),
});
