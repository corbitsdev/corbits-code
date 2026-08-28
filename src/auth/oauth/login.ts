import { openInBrowser } from "./browser.js";
import type { CallbackServer } from "./callback-server.js";
import { generatePkce, generateState, type Pkce } from "./pkce.js";
import type { AuthProfile, BaseTokens } from "./store.js";

export interface StagedOAuthProfile<TTokens extends BaseTokens> {
  readonly profile: AuthProfile<TTokens>;
  readonly commit: () => Promise<void>;
}

export interface OAuthLoginHandle<TTokens extends BaseTokens> {
  // The URL to authorize at — surfaced as a copyable link in the TUI and also
  // handed to the browser opener.
  authorizeUrl: string;
  // Resolves after consent and exchange with an in-memory profile. The caller
  // commits it only once provider setup has authorized durable mutation.
  completed: Promise<StagedOAuthProfile<TTokens>>;
  // Tear down the callback server (also triggered via the abort signal).
  cancel: () => void;
}

export interface StartOAuthLoginOptions {
  profile: string;
  signal: AbortSignal;
  // Injected for tests; defaults to the real clock.
  now?: () => number;
  home?: string;
  // When false, the browser is not auto-opened (the caller surfaces the link).
  // Defaults to true.
  openBrowser?: boolean;
}

export interface OAuthLoginDeps<TTokens extends BaseTokens> {
  startCallbackServer: (expectedState: string) => Promise<CallbackServer>;
  buildAuthorizeUrl: (pkce: Pkce, state: string) => string;
  exchangeCode: (code: string, verifier: string, now: number) => Promise<TTokens>;
  saveProfile: (
    profile: { name: string; tokens: TTokens; createdAt: number },
    home?: string,
  ) => Promise<void>;
}

// Drive the loopback PKCE login: start the callback server, build the authorize
// URL, and return a handle whose `completed` promise resolves after the browser
// round-trip and token exchange. The server is always closed, whether the flow
// succeeds, fails, or is aborted.
export async function startOAuthLogin<TTokens extends BaseTokens>(
  opts: StartOAuthLoginOptions,
  deps: OAuthLoginDeps<TTokens>,
): Promise<OAuthLoginHandle<TTokens>> {
  const now = opts.now ?? Date.now;
  const pkce = generatePkce();
  const state = generateState();
  const server = await deps.startCallbackServer(state);
  const authorizeUrl = deps.buildAuthorizeUrl(pkce, state);

  const completed = (async (): Promise<StagedOAuthProfile<TTokens>> => {
    try {
      const code = await server.waitForCode(opts.signal);
      const tokens = await deps.exchangeCode(code, pkce.verifier, now());
      const profile = { name: opts.profile, tokens, createdAt: now() };
      let committed: Promise<void> | undefined;
      return {
        profile,
        commit: () => {
          if (!committed) {
            const attempt = deps.saveProfile(profile, opts.home);
            committed = attempt;
            void attempt.catch(() => {
              if (committed === attempt) committed = undefined;
            });
          }
          return committed;
        },
      };
    } finally {
      server.close();
    }
  })();
  // The flow's own error handling lives with whoever awaits `completed`; attach
  // a no-op catch so an abort before anyone awaits does not surface as an
  // unhandled rejection.
  completed.catch(() => undefined);

  if (opts.openBrowser !== false) openInBrowser(authorizeUrl);

  return {
    authorizeUrl,
    completed,
    cancel: () => server.close(),
  };
}
