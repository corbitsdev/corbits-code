// Shared PKCE + loopback OAuth plumbing used by provider-specific auth stacks
// (Codex, xAI, …). Provider modules own endpoints, ports, headers, and account
// metadata; this package owns the common request shape and session lifecycle.

export { generatePkce, generateState, type Pkce } from "./pkce.js";
export { openInBrowser } from "./browser.js";
export {
  startCallbackServer,
  authorizationDoneHtml,
  type CallbackServer,
  type CallbackServerConfig,
} from "./callback-server.js";
export {
  createAuthStore,
  type AuthProfile,
  type AuthStore,
  type AuthStoreOptions,
  type BaseTokens,
} from "./store.js";
export {
  buildAuthorizeUrl,
  baseTokensFromResponse,
  exchangeCode,
  postToken,
  refreshTokenRequest,
  TokenResponseSchema,
  type OAuthClientConfig,
  type TokenResponse,
} from "./client.js";
export {
  startOAuthLogin,
  type OAuthLoginDeps,
  type OAuthLoginHandle,
  type StagedOAuthProfile,
  type StartOAuthLoginOptions,
} from "./login.js";
export {
  createTokenSession,
  isTokenExpired,
  type TokenSession,
  type TokenSessionDeps,
} from "./session.js";
