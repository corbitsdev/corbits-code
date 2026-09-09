import { homedir } from "node:os";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  tryLoadAuthStateSync,
  updateAuthState,
  type MCPAuthIdentity,
  type MCPAuthState,
} from "./auth-store.js";
import { MCP_CLIENT_NAME } from "../branding.js";

export interface OAuthProviderOptions {
  serverName: string;
  serverURL: string;
  redirectUrl: string;
  onAuthURL: (serverName: string, authorizationUrl: string) => void;
  onAuthorizationState?: (state: string) => void;
  home?: string;
}
export type CorbitsOAuthProvider = OAuthClientProvider & { resetAuthorization(): Promise<void> };

function redirectUrisInclude(
  info: OAuthClientInformationFull | undefined,
  redirectUrl: string,
): boolean {
  const uris = info?.redirect_uris;
  if (uris === undefined || uris.length === 0) return true;
  return uris.includes(redirectUrl);
}

// Dynamic client registration bakes in the loopback redirect_uri (ephemeral port).
// A later session that binds a new port cannot reuse that client_id for authorize
// / token exchange — drop the stale registration when we have no refreshable
// tokens and must run the browser flow again.
function dropStaleClientRegistration(state: MCPAuthState, redirectUrl: string): void {
  if (state.tokens !== undefined) return;
  if (redirectUrisInclude(state.clientInformation, redirectUrl)) return;
  delete state.clientInformation;
  delete state.codeVerifier;
}

function shouldAdoptClient(stored: MCPAuthState, next: MCPAuthState, redirectUrl: string): boolean {
  if (next.clientInformation === undefined) return false;
  if (redirectUrisInclude(next.clientInformation, redirectUrl)) return true;
  // Other-port DCR is a sibling's in-progress registration unless they also
  // published new tokens (completed re-auth).
  return next.tokens !== undefined && next.tokens.access_token !== stored.tokens?.access_token;
}

function assignTokens(stored: MCPAuthState, next: MCPAuthState): void {
  if (next.tokens !== undefined) stored.tokens = next.tokens;
  else delete stored.tokens;
}

function assignClient(stored: MCPAuthState, next: MCPAuthState): void {
  if (next.clientInformation !== undefined) stored.clientInformation = next.clientInformation;
  else delete stored.clientInformation;
}

export async function createOAuthProvider(
  opts: OAuthProviderOptions,
): Promise<CorbitsOAuthProvider> {
  const identity: MCPAuthIdentity = {
    serverName: opts.serverName,
    serverURL: opts.serverURL,
  };
  const home = opts.home ?? homedir();
  // Load + scrub stale DCR under the per-file chain so concurrent providers see
  // the same cleaned state. Mutations always re-read disk; tokens and matching
  // DCR are observed from disk so a sibling session's completed auth is picked
  // up. PKCE stays instance-local after this snapshot — a different-port sibling
  // must not clobber an in-progress verifier.
  const stored: MCPAuthState = await updateAuthState(
    identity,
    (state) => {
      dropStaleClientRegistration(state, opts.redirectUrl);
    },
    home,
  );

  const apply = async (mutator: (state: MCPAuthState) => void): Promise<void> => {
    const next = await updateAuthState(identity, mutator, home);
    assignTokens(stored, next);
    assignClient(stored, next);
  };

  const refreshDurableFromDisk = (): void => {
    const next = tryLoadAuthStateSync(identity, home);
    if (next === undefined) return;
    const adoptClient = shouldAdoptClient(stored, next, opts.redirectUrl);
    assignTokens(stored, next);
    if (adoptClient) assignClient(stored, next);
  };

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
        client_name: MCP_CLIENT_NAME,
        redirect_uris: [opts.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      refreshDurableFromDisk();
      return stored.clientInformation;
    },
    saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
      stored.clientInformation = info as OAuthClientInformationFull;
      return apply((state) => {
        state.clientInformation = info as OAuthClientInformationFull;
      });
    },
    tokens(): OAuthTokens | undefined {
      refreshDurableFromDisk();
      return stored.tokens;
    },
    saveTokens(tokens: OAuthTokens): Promise<void> {
      return apply((state) => {
        state.tokens = tokens;
      });
    },
    redirectToAuthorization(authorizationUrl: URL): void {
      const state = authorizationUrl.searchParams.get("state");
      if (state !== null) opts.onAuthorizationState?.(state);
      opts.onAuthURL(opts.serverName, authorizationUrl.toString());
    },
    saveCodeVerifier(codeVerifier: string): Promise<void> {
      stored.codeVerifier = codeVerifier;
      return apply((state) => {
        state.codeVerifier = codeVerifier;
      });
    },
    codeVerifier(): string {
      if (stored.codeVerifier === undefined)
        throw new Error("No PKCE code verifier saved for this authorization.");
      return stored.codeVerifier;
    },
    async resetAuthorization(): Promise<void> {
      oauthState = undefined;
      await apply((state) => {
        delete state.tokens;
        delete state.codeVerifier;
        // Next browser flow needs a client registered for *this* loopback port.
        if (!redirectUrisInclude(state.clientInformation, opts.redirectUrl)) {
          delete state.clientInformation;
        }
      });
      delete stored.codeVerifier;
    },
  };
}
