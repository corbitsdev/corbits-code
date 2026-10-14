import { bearerHeaders } from "../bearer-headers.js";
import {
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_USER_AGENT,
  xaiUserIdFromAccessToken,
} from "@corbits/xai-provider";

export function xaiAuthHeadersForToken(token: {
  readonly access: string;
}): Record<string, string> {
  const headers = bearerHeaders(token, {
    "user-agent": XAI_USER_AGENT,
    "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
    "x-grok-client-version": XAI_CLIENT_VERSION,
  });
  const userId = xaiUserIdFromAccessToken(token.access);
  if (userId !== undefined) headers["x-grok-user-id"] = userId;
  return headers;
}
