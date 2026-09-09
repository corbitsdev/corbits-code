// Codex OAuth helpers — see the shared factory in ./provider.ts.
export { codexOAuthConfig, accountIdFromIdToken } from "./provider.js";
import { codexAuth } from "./provider.js";

export const buildAuthorizeUrl = codexAuth.buildAuthorizeUrl;
export const tokensFromResponse = codexAuth.tokensFromResponse;
export const exchangeCode = codexAuth.exchangeCode;
export const refreshTokens = codexAuth.refreshTokens;
