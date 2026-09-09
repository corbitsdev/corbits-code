import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  authFilePath,
  loadAuthStateSync,
  updateAuthState,
  type MCPAuthIdentity,
  type MCPAuthState,
} from "./auth-store.js";
import { statSync } from "node:fs";
import { homedir } from "node:os";
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

function replaceStored(stored: MCPAuthState, next: MCPAuthState): void {
  delete stored.clientInformation;
  delete stored.tokens;
  delete stored.codeVerifier;
  if (next.clientInformation !== undefined) stored.clientInformation = next.clientInformation;
  if (next.tokens !== undefined) stored.tokens = next.tokens;
  if (next.codeVerifier !== undefined) stored.codeVerifier = next.codeVerifier;
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
  // the same cleaned state. Mutations always re-read disk; the in-memory mirror
  // serves the SDK's sync getters, refreshed from disk when the auth file
  // changes so tokens saved by another session are picked up immediately.
  const stored: MCPAuthState = await updateAuthState(
    identity,
    (state) => {
      dropStaleClientRegistration(state, opts.redirectUrl);
    },
    home,
  );

  const apply = async (mutator: (state: MCPAuthState) => void): Promise<void> => {
    const next = await updateAuthState(identity, mutator, home);
    replaceStored(stored, next);
  };

  // Cheap staleness guard: statSync per getter, sync read only when the file's
  // mtime or size changed. A vanished file keeps the mirror rather than throwing.
  const authPath = authFilePath(identity, home);
  let seenStamp: string | undefined;
  const refreshFromDisk = (): void => {
    let stamp: string | undefined;
    try {
      const stat = statSync(authPath);
      stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
    } catch {
      // File gone (or unreadable): keep serving the in-memory mirror rather
      // than throwing from a sync getter.
      if (seenStamp === undefined) return;
      seenStamp = undefined;
      return;
    }
    if (stamp === seenStamp) return;
    let next: MCPAuthState;
    try {
      next = loadAuthStateSync(identity, home);
    } catch {
      // Unreadable rather than missing: leave the stamp stale so the next
      // getter call retries instead of pinning an empty state over the mirror.
      return;
    }
    seenStamp = stamp;
    replaceStored(stored, next);
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
      refreshFromDisk();
      return stored.clientInformation;
    },
    saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
      return apply((state) => {
        state.clientInformation = info as OAuthClientInformationFull;
      });
    },
    tokens(): OAuthTokens | undefined {
      refreshFromDisk();
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
      return apply((state) => {
        state.codeVerifier = codeVerifier;
      });
    },
    codeVerifier(): string {
      refreshFromDisk();
      if (stored.codeVerifier === undefined)
        throw new Error("No PKCE code verifier saved for this authorization.");
      return stored.codeVerifier;
    },
    resetAuthorization(): Promise<void> {
      oauthState = undefined;
      return apply((state) => {
        delete state.tokens;
        delete state.codeVerifier;
        // Next browser flow needs a client registered for *this* loopback port.
        if (!redirectUrisInclude(state.clientInformation, opts.redirectUrl)) {
          delete state.clientInformation;
        }
      });
    },
  };
}
