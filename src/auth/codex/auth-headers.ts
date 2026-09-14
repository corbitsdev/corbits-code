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
  if (token.accountId !== undefined)
    headers["chatgpt-account-id"] = token.accountId;
  return headers;
}
