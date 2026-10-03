import type { AuthProfile } from "@corbits/oauth-core";
import type { MetaOAuthTokens } from "@corbits/meta-provider";
import { type } from "arktype";

import { createAuthStore } from "../store.js";

export type { MetaOAuthTokens };

export type MetaProfile = AuthProfile<MetaOAuthTokens>;

const MetaTokensShape = type({
  access: "string",
  refresh: "string",
  expiresAt: "number",
  "idToken?": "string",
});

function isMetaTokens(value: unknown): value is MetaOAuthTokens {
  return !(MetaTokensShape(value) instanceof type.errors);
}

export const META_AUTH_FILENAME = "meta-auth.json";

export function createMetaAuthStore(settingsDirName: string) {
  return createAuthStore<MetaOAuthTokens>({
    filename: META_AUTH_FILENAME,
    settingsDirName,
    isTokens: isMetaTokens,
  });
}
