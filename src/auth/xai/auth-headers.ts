import { xaiUserIdFromAccessToken } from "@corbits/xai-provider";

import {
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_USER_AGENT,
} from "./constants.js";

export function xaiAuthHeadersForToken(token: {
  readonly access: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.access}`,
    "user-agent": XAI_USER_AGENT,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_CLIENT_VERSION,
  };
  const userId = xaiUserIdFromAccessToken(token.access);
  if (userId !== undefined) headers["x-grok-user-id"] = userId;
  return headers;
}
