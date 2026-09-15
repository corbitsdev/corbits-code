import { CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from "./constants.js";

export function codexAuthHeadersForToken(
  token: {
    readonly access: string;
    readonly accountId?: string | undefined;
  },
  commandName: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.access}`,
    originator: CODEX_ORIGINATOR,
    "user-agent": `${commandName} (${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION})`,
  };
  // An empty account id carries no identity — sending it as a header value
  // would label the request with a meaningless id. Only a non-empty id rides.
  if (token.accountId) headers["chatgpt-account-id"] = token.accountId;
  return headers;
}
