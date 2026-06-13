import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { loadAuthState, saveAuthState, type MCPAuthState } from "./auth-store.js";

export type OAuthProviderOptions = {
  serverName: string;
  // Loopback URL the authorization server redirects back to after consent.
  redirectUrl: string;
  // Invoked with the authorization URL instead of opening a browser, so the TUI
  // can surface a copyable link.
  onAuthURL: (serverName: string, authorizationUrl: string) => void;
  home?: string;
};

// An OAuthClientProvider backed by the on-disk auth store. State is loaded once
// up front and persisted on every mutation; the SDK drives the rest of the flow
// (discovery, dynamic registration, PKCE, token exchange and refresh).
export async function createOAuthProvider(opts: OAuthProviderOptions): Promise<OAuthClientProvider> {
  const stored: MCPAuthState = await loadAuthState(opts.serverName, opts.home);
  const persist = (): Promise<void> => saveAuthState(opts.serverName, stored, opts.home);

  // CSRF state parameter. Generated once per authorization and held for the life
  // of this provider so repeated reads during a single flow are stable. Some
  // authorization servers (Linear among them) reject an authorize request that
  // omits `state` with "Invalid flow state".
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
        client_name: "intercode",
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
      opts.onAuthURL(opts.serverName, authorizationUrl.toString());
    },

    saveCodeVerifier(codeVerifier: string): Promise<void> {
      stored.codeVerifier = codeVerifier;
      return persist();
    },

    codeVerifier(): string {
      if (stored.codeVerifier === undefined) {
        throw new Error("No PKCE code verifier saved for this authorization.");
      }
      return stored.codeVerifier;
    },
  };
}
