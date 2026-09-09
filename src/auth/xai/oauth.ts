// xAI OAuth helpers — see the shared factory in ./provider.ts.
export { xaiOAuthConfig } from "./provider.js";
import { xaiAuth } from "./provider.js";

export const buildAuthorizeUrl = xaiAuth.buildAuthorizeUrl;
export const tokensFromResponse = xaiAuth.tokensFromResponse;
export const exchangeCode = xaiAuth.exchangeCode;
export const refreshTokens = xaiAuth.refreshTokens;
