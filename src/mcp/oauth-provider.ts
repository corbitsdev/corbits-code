import { homedir } from "node:os";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
  selectResourceURL,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  updateAuthState,
  type MCPAuthIdentity,
  type MCPAuthState,
} from "./auth-store.js";
import { isAbortError } from "./quiet.js";
import { MCP_CLIENT_NAME } from "../branding.js";

export interface OAuthProviderOptions {
  serverName: string;
  serverURL: string;
  redirectUrl: string;
  onAuthURL: (serverName: string, authorizationUrl: string) => void;
  onAuthorizationState?: (state: string) => void;
  home?: string;
  fetchFn?: FetchLike;
}
export type CorbitsOAuthProvider = OAuthClientProvider & {
  resetAuthorization(): Promise<void>;
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
};

function redirectUrisInclude(
  info: OAuthClientInformationFull | undefined,
  redirectUrl: string,
): boolean {
  const uris = info?.redirect_uris;
  if (uris === undefined || uris.length === 0) return true;
  return uris.includes(redirectUrl);
}

// DCR bakes in the loopback redirect_uri (ephemeral port); a new-port session
// cannot reuse that client_id, so drop the stale registration when no tokens remain.
function dropStaleClientRegistration(
  state: MCPAuthState,
  redirectUrl: string,
): void {
  if (state.tokens !== undefined) return;
  if (redirectUrisInclude(state.clientInformation, redirectUrl)) return;
  delete state.clientInformation;
}

export async function createOAuthProvider(
  opts: OAuthProviderOptions,
): Promise<CorbitsOAuthProvider> {
  const identity: MCPAuthIdentity = {
    serverName: opts.serverName,
    serverURL: opts.serverURL,
  };
  const home = opts.home ?? homedir();
  // Scrub a legacy disk verifier under the per-file chain. A mismatched client
  // is removed from this instance's memory so the new port does not reuse it.
  // It is removed from disk only when a legacy codeVerifier is still stored
  // beside it; a sibling's in-progress registration has no verifier on disk and
  // must survive this construct. PKCE for this instance stays in memory.
  const durable = await updateAuthState(
    identity,
    (state) => {
      if (!("codeVerifier" in state)) return;
      dropStaleClientRegistration(state, opts.redirectUrl);
    },
    home,
  );
  const stored: MCPAuthState = { ...durable };
  dropStaleClientRegistration(stored, opts.redirectUrl);

  // Load-mutate-save one field. Memory keeps the value this provider just set;
  // the write must not copy a sibling's other field back over it.
  const apply = async (
    mutator: (state: MCPAuthState) => void,
  ): Promise<void> => {
    await updateAuthState(identity, mutator, home);
  };

  let oauthState: string | undefined;
  // PKCE verifier: instance-local only, never persisted. The browser flow
  // starts and ends in one provider episode, so a sibling must neither see
  // nor clobber it.
  let pkceVerifier: string | undefined;
  let authorizationServerMetadata: AuthorizationServerMetadata | undefined;
  let authorizationServerUrl: string | undefined;
  let resource: URL | undefined;
  const provider: CorbitsOAuthProvider = {
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
      return stored.clientInformation;
    },
    saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
      const clientInformation = info as OAuthClientInformationFull;
      stored.clientInformation = clientInformation;
      return apply((state) => {
        state.clientInformation = clientInformation;
      });
    },
    tokens(): OAuthTokens | undefined {
      return stored.tokens;
    },
    saveTokens(tokens: OAuthTokens): Promise<void> {
      stored.tokens = tokens;
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
      pkceVerifier = codeVerifier;
      return Promise.resolve();
    },
    codeVerifier(): string {
      if (pkceVerifier === undefined)
        throw new Error("No PKCE code verifier saved for this authorization.");
      return pkceVerifier;
    },
    async resetAuthorization(): Promise<void> {
      oauthState = undefined;
      pkceVerifier = undefined;
      // Compare disk to this instance's memory. Do not adopt a sibling's
      // credentials into memory before deciding what to delete.
      const previous = stored.tokens?.access_token;
      await apply((state) => {
        if (state.tokens?.access_token === previous) {
          delete state.tokens;
        }
        // Only this instance's registration. A sibling's redirect must stay
        // on disk so its tokens still have a client.
        if (redirectUrisInclude(state.clientInformation, opts.redirectUrl)) {
          delete state.clientInformation;
        }
      });
      if (stored.tokens?.access_token === previous) {
        delete stored.tokens;
      }
      delete stored.clientInformation;
    },
    refreshToken: async (refreshToken: string): Promise<OAuthTokens> => {
      try {
        const fetchFn = opts.fetchFn;
        if (
          authorizationServerMetadata === undefined ||
          authorizationServerUrl === undefined
        ) {
          let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
          try {
            resourceMetadata = await discoverOAuthProtectedResourceMetadata(
              opts.serverURL,
              undefined,
              fetchFn,
            );
          } catch {
            resourceMetadata = undefined;
          }
          const fromPrm = resourceMetadata?.authorization_servers?.[0];
          authorizationServerUrl =
            fromPrm === undefined
              ? String(new URL("/", opts.serverURL))
              : String(fromPrm);
          authorizationServerMetadata =
            (await discoverAuthorizationServerMetadata(
              authorizationServerUrl,
              fetchFn === undefined ? {} : { fetchFn },
            )) ?? undefined;
          resource =
            (await selectResourceURL(
              opts.serverURL,
              provider,
              resourceMetadata,
            )) ?? resourceUrlFromServerUrl(opts.serverURL);
        }
        if (authorizationServerMetadata === undefined)
          throw new UnauthorizedError(
            "authorization server metadata unavailable",
          );
        const clientInformation = stored.clientInformation;
        if (clientInformation === undefined)
          throw new UnauthorizedError("no client registration to refresh");
        const resourceURL =
          resource ?? resourceUrlFromServerUrl(opts.serverURL);
        const tokens = await refreshAuthorization(authorizationServerUrl, {
          metadata: authorizationServerMetadata,
          clientInformation,
          refreshToken,
          resource: resourceURL,
          ...(fetchFn === undefined ? {} : { fetchFn }),
        });
        // SDK >= 1.31 binds stored credentials to their authorization server
        // via an `issuer` stamp; the transport's auth() stamps its own saves,
        // so refresh here must too — unstamped tokens would re-trigger the
        // SDK's stored-tokens-without-issuer deprecation warning on the next
        // auth() and stay unbound.
        const boundTokens: OAuthTokens = {
          ...tokens,
          issuer: authorizationServerUrl,
        };
        await provider.saveTokens(boundTokens);
        return boundTokens;
      } catch (err) {
        if (isAbortError(err) || err instanceof UnauthorizedError) throw err;
        throw new UnauthorizedError(
          `Token refresh failed for ${opts.serverName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
  return provider;
}
