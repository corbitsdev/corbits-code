// Generic OAuth provider stack factory. The provider-specific layers (xai,
// codex) used to re-implement the same store/session/oauth/login/callback
// wiring per provider; this factory builds the whole stack from one config so
// a provider owns only its constants, token shape, and messages.
//
// A provider module calls `createProviderAuth` with its config and re-exports
// the returned surface under its public names (see auth/xai/provider.ts and
// auth/codex/provider.ts).

import {
  buildAuthorizeUrl as buildSharedAuthorizeUrl,
  exchangeCode as exchangeSharedCode,
  refreshTokenRequest,
  type OAuthClientConfig,
  type TokenResponse,
} from "./client.js";
import {
  authorizationDoneHtml,
  startCallbackServer as startSharedCallbackServer,
  type CallbackServer,
  type CallbackServerConfig,
} from "./callback-server.js";
import { startOAuthLogin, type OAuthLoginHandle, type StartOAuthLoginOptions } from "./login.js";
import type { Pkce } from "./pkce.js";
import { createTokenSession, type TokenSession } from "./session.js";
import { createAuthStore, type AuthStore, type BaseTokens } from "./store.js";

/** Error raised when a provider profile cannot yield a usable access token. */
export interface ProviderAuthError extends Error {
  readonly profile: string;
  readonly reason: "missing" | "refresh-failed";
}

export type ProviderAuthErrorConstructor = new (
  profile: string,
  reason: "missing" | "refresh-failed",
  message: string,
) => ProviderAuthError;

// Build the provider-named error class ("XaiAuthError", "CodexAuthError", …).
// `name` must equal the provider key exactly: callers classify OAuth send
// failures by `err.name` (see tui/runner/submit.ts) and by instanceof.
function createAuthErrorClass(errorName: string): ProviderAuthErrorConstructor {
  return class ProviderAuthErrorImpl extends Error {
    readonly profile: string;
    readonly reason: "missing" | "refresh-failed";

    constructor(profile: string, reason: "missing" | "refresh-failed", message: string) {
      super(message);
      this.name = errorName;
      this.profile = profile;
      this.reason = reason;
    }
  };
}

export interface ProviderAuthConfig<TTokens extends BaseTokens, TAccess> {
  /** Error class name, e.g. "XaiAuthError". Must match the provider key. */
  errorName: string;
  /** Product label used in user-facing messages ("xAI", "Codex", …). */
  label: string;
  /** Profile-store filename under ~/.corbits/ (e.g. "xai-auth.json"). */
  filename: string;
  /** OAuth client endpoints, scopes, and timeout (see client.ts). */
  oauth: OAuthClientConfig;
  /** Loopback callback-server binding. doneHtml/label derive from `label`. */
  callback: Omit<CallbackServerConfig, "doneHtml" | "label">;
  isTokens: (value: unknown) => value is TTokens;
  /**
   * Map a raw token response onto the provider's stored token shape. `now` is
   * injectable so callers (and tests) control the expiry baseline;
   * `previousRefresh` is carried forward when a refresh response omits a new
   * refresh_token (servers may rotate or not).
   */
  tokensFromResponse: (response: TokenResponse, now: number, previousRefresh?: string) => TTokens;
  refreshSkewMs: number;
  /** Project stored tokens into the access shape returned to callers. */
  toAccess: (tokens: TTokens) => TAccess;
  /** Optional merge when a refresh response omits provider-specific fields. */
  mergeRefreshed?: (refreshed: TTokens, previous: TTokens) => TTokens;
  missingError: (name: string) => string;
  refreshFailedError: (name: string, cause: unknown) => string;
}

/** The complete per-provider auth stack produced by {@link createProviderAuth}. */
export interface ProviderAuth<TTokens extends BaseTokens, TAccess> {
  /** Provider-named error class (also used for instanceof checks). */
  AuthError: ProviderAuthErrorConstructor;
  store: AuthStore<TTokens>;
  buildAuthorizeUrl: (pkce: Pkce, state: string) => string;
  tokensFromResponse: (response: TokenResponse, now: number, previousRefresh?: string) => TTokens;
  exchangeCode: (code: string, verifier: string, now: number) => Promise<TTokens>;
  refreshTokens: (refreshToken: string, now: number) => Promise<TTokens>;
  startCallbackServer: (expectedState: string) => Promise<CallbackServer>;
  startLogin: (opts: StartOAuthLoginOptions) => Promise<OAuthLoginHandle<TTokens>>;
  session: TokenSession<TTokens, TAccess>;
  /** Refresh in place when at/over expiry; otherwise return tokens unchanged. */
  refreshStaged: (tokens: TTokens, now?: number) => Promise<TTokens>;
}

export function createProviderAuth<TTokens extends BaseTokens, TAccess>(
  config: ProviderAuthConfig<TTokens, TAccess>,
): ProviderAuth<TTokens, TAccess> {
  const AuthError = createAuthErrorClass(config.errorName);
  const store = createAuthStore<TTokens>({
    filename: config.filename,
    isTokens: config.isTokens,
  });

  const buildAuthorizeUrl = (pkce: Pkce, state: string): string =>
    buildSharedAuthorizeUrl(config.oauth, pkce, state);

  const exchangeCode = async (code: string, verifier: string, now: number): Promise<TTokens> =>
    config.tokensFromResponse(await exchangeSharedCode(config.oauth, code, verifier), now);

  const refreshTokens = async (refreshToken: string, now: number): Promise<TTokens> =>
    config.tokensFromResponse(
      await refreshTokenRequest(config.oauth, refreshToken),
      now,
      refreshToken,
    );

  const startCallbackServer = (expectedState: string): Promise<CallbackServer> =>
    startSharedCallbackServer(expectedState, {
      ...config.callback,
      doneHtml: authorizationDoneHtml(config.label),
      label: config.label,
    });

  const startLogin = (opts: StartOAuthLoginOptions): Promise<OAuthLoginHandle<TTokens>> =>
    startOAuthLogin(opts, {
      startCallbackServer,
      buildAuthorizeUrl,
      exchangeCode,
      saveProfile: store.saveProfile,
    });

  const session = createTokenSession<TTokens, TAccess>({
    skewMs: config.refreshSkewMs,
    loadProfile: store.loadProfile,
    updateTokens: store.updateTokens,
    refreshTokens,
    toAccess: config.toAccess,
    ...(config.mergeRefreshed !== undefined ? { mergeRefreshed: config.mergeRefreshed } : {}),
    missingError: (name) => new AuthError(name, "missing", config.missingError(name)),
    refreshFailedError: (name, cause) =>
      new AuthError(name, "refresh-failed", config.refreshFailedError(name, cause)),
  });

  const refreshStaged = async (tokens: TTokens, now: number = Date.now()): Promise<TTokens> => {
    if (!session.isExpired(tokens, now)) return tokens;
    const refreshed = await refreshTokens(tokens.refresh, now);
    Object.assign(tokens, refreshed);
    return tokens;
  };

  return {
    AuthError,
    store,
    buildAuthorizeUrl,
    tokensFromResponse: config.tokensFromResponse,
    exchangeCode,
    refreshTokens,
    startCallbackServer,
    startLogin,
    session,
    refreshStaged,
  };
}
