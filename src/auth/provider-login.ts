import {
  buildAuthorizeUrl,
  startOAuthLogin,
  type CallbackServer,
  type OAuthClientConfig,
  type OAuthLoginHandle,
  type StartOAuthLoginOptions,
} from "@corbits/oauth-core";
import type { BaseTokens } from "@corbits/oauth-core";

export interface ProviderLoginSpec<TTokens extends BaseTokens = BaseTokens> {
  oauthConfig: OAuthClientConfig;
  startCallbackServer: (expectedState: string) => Promise<CallbackServer>;
  exchangeCode: (
    code: string,
    verifier: string,
    now: number,
  ) => Promise<TTokens>;
  saveProfile: (profile: {
    name: string;
    tokens: TTokens;
    createdAt: number;
  }) => Promise<void>;
}

// The shared PKCE login skeleton: every provider supplies its OAuth config,
// exchange, and persistence while the loopback flow stays in one place.
export function startProviderLogin<TTokens extends BaseTokens>(
  opts: StartOAuthLoginOptions,
  spec: ProviderLoginSpec<TTokens>,
): Promise<OAuthLoginHandle<TTokens>> {
  return startOAuthLogin(opts, {
    startCallbackServer: spec.startCallbackServer,
    buildAuthorizeUrl: (pkce, state) =>
      buildAuthorizeUrl(spec.oauthConfig, pkce, state),
    exchangeCode: (code, verifier, now) =>
      spec.exchangeCode(code, verifier, now),
    saveProfile: (profile) => spec.saveProfile(profile),
  });
}
