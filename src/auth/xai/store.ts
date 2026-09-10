import type { AuthProfile } from "@corbits/oauth-core";
import type { XaiTokens } from "@corbits/xai-provider";
import { type } from "arktype";

import { createAuthStore } from "../store.js";

export type { XaiTokens };

export type XaiProfile = AuthProfile<XaiTokens>;

const XaiTokensShape = type({
  access: "string",
  refresh: "string",
  expiresAt: "number",
  "idToken?": "string",
});

function isXaiTokens(value: unknown): value is XaiTokens {
  return !(XaiTokensShape(value) instanceof type.errors);
}

export function createXaiAuthStore(settingsDirName: string) {
  return createAuthStore<XaiTokens>({
    filename: "xai-auth.json",
    settingsDirName,
    isTokens: isXaiTokens,
  });
}
