import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { loadAuthState, saveAuthState, type McpAuthState } from "./token-store.js";

export type OAuthProviderOptions = {
  clientName: string;
  serverName: string;
  redirectUrl: string;
  onAuthURL: (serverName: string, authorizationUrl: string) => void;
  onAuthorizationState?: (state: string) => void;
  home?: string;
};

export type McpOAuthProvider = OAuthClientProvider & { resetAuthorization(): Promise<void> };

export async function createOAuthProvider(opts: OAuthProviderOptions): Promise<McpOAuthProvider> {
  const stored: McpAuthState = await loadAuthState(opts.serverName, opts.home);
  const persist = (): Promise<void> => saveAuthState(opts.serverName, stored, opts.home);
  let oauthState: string | undefined;
  return {
    get redirectUrl(): string {
      return opts.redirectUrl;
    },
    state(): string {
      if (oauthState === undefined) oauthState = crypto.randomUUID();
      return oauthState;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: opts.clientName,
        redirect_uris: [opts.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      return stored.clientInformation;
    },
    saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
      stored.clientInformation = info as OAuthClientInformationFull;
      return persist();
    },
    tokens(): OAuthTokens | undefined {
      return stored.tokens;
    },
    saveTokens(tokens: OAuthTokens): Promise<void> {
      stored.tokens = tokens;
      return persist();
    },
    redirectToAuthorization(authorizationUrl: URL): void {
      const state = authorizationUrl.searchParams.get("state");
      if (state !== null) opts.onAuthorizationState?.(state);
      opts.onAuthURL(opts.serverName, authorizationUrl.toString());
    },
    saveCodeVerifier(codeVerifier: string): Promise<void> {
      stored.codeVerifier = codeVerifier;
      return persist();
    },
    codeVerifier(): string {
      if (stored.codeVerifier === undefined) throw new Error("No PKCE code verifier saved for this authorization.");
      return stored.codeVerifier;
    },
    resetAuthorization(): Promise<void> {
      delete stored.tokens;
      delete stored.codeVerifier;
      oauthState = undefined;
      return persist();
    },
  };
}
