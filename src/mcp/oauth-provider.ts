import { statSync } from "node:fs";
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
  authFilePath,
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

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && err.name === "AbortError";
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

function matchingLiveClient(
  stored: MCPAuthState,
  redirectUrl: string,
): OAuthClientInformationFull | undefined {
  const live = stored.clientInformation;
  if (live === undefined || !redirectUrisInclude(live, redirectUrl)) return undefined;
  return live;
}

function persistMatchingLiveClient(
  stored: MCPAuthState,
  next: MCPAuthState,
  redirectUrl: string,
): void {
  const live = matchingLiveClient(stored, redirectUrl);
  if (live === undefined) return;
  next.clientInformation = live;
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
    const next = await updateAuthState(
      identity,
      (state) => {
        mutator(state);
        persistMatchingLiveClient(stored, state, opts.redirectUrl);
      },
      home,
    );
    assignTokens(stored, next);
    if (matchingLiveClient(stored, opts.redirectUrl) === undefined) {
      assignClient(stored, next);
    }
  };

  // Cheap staleness guard: statSync per getter, sync read only when the file's
  // mtime or size changed. Stamp commits only after a successful read so a
  // failed/unreadable file is retried on the next getter call.
  const authPath = authFilePath(identity, home);
  let seenStamp: string | undefined;
  const refreshDurableFromDisk = (): void => {
    let stamp: string | undefined;
    try {
      const stat = statSync(authPath);
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
    } catch {
      if (seenStamp === undefined) return;
      seenStamp = undefined;
      return;
    }
    if (stamp === seenStamp) return;
    const next = tryLoadAuthStateSync(identity, home);
    if (next === undefined) return;
    seenStamp = stamp;
    const adoptClient = shouldAdoptClient(stored, next, opts.redirectUrl);
    assignTokens(stored, next);
    if (adoptClient) assignClient(stored, next);
  };

  let oauthState: string | undefined;
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
      // Snapshot before the disk refresh so a session that never held tokens
      // cannot adopt a sibling's credentials and then delete them.
      const previous = stored.tokens?.access_token;
      refreshDurableFromDisk();
      await apply((state) => {
        if (state.tokens?.access_token === previous) {
          delete state.tokens;
        }
        delete state.codeVerifier;
        // Next browser flow needs a client registered for *this* loopback port.
        if (!redirectUrisInclude(state.clientInformation, opts.redirectUrl)) {
          delete state.clientInformation;
        }
      });
      delete stored.codeVerifier;
    },
    refreshToken: async (refreshToken: string): Promise<OAuthTokens> => {
      try {
        const fetchFn = opts.fetchFn;
        if (authorizationServerMetadata === undefined || authorizationServerUrl === undefined) {
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
            fromPrm === undefined ? String(new URL("/", opts.serverURL)) : String(fromPrm);
          authorizationServerMetadata =
            (await discoverAuthorizationServerMetadata(
              authorizationServerUrl,
              fetchFn === undefined ? {} : { fetchFn },
            )) ?? undefined;
          resource =
            (await selectResourceURL(opts.serverURL, provider, resourceMetadata)) ??
            resourceUrlFromServerUrl(opts.serverURL);
        }
        if (authorizationServerMetadata === undefined)
          throw new UnauthorizedError("authorization server metadata unavailable");
        const clientInformation = stored.clientInformation;
        if (clientInformation === undefined)
          throw new UnauthorizedError("no client registration to refresh");
        const resourceURL = resource ?? resourceUrlFromServerUrl(opts.serverURL);
        const tokens = await refreshAuthorization(authorizationServerUrl, {
          metadata: authorizationServerMetadata,
          clientInformation,
          refreshToken,
          resource: resourceURL,
          ...(fetchFn === undefined ? {} : { fetchFn }),
        });
        await apply((state) => {
          state.tokens = tokens;
        });
        return tokens;
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
