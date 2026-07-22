import { openInBrowser } from "./browser.js";
import type { CallbackServer } from "./callback-server.js";
import { generatePkce, generateState, type Pkce } from "./pkce.js";

export type OAuthLoginHandle = {
  // The URL to authorize at — surfaced as a copyable link in the TUI and also
  // handed to the browser opener.
  authorizeUrl: string;
  // Resolves once the user completes consent and tokens are stored, or rejects
  // on error/abort. The resolved name echoes the profile that was saved.
  completed: Promise<{ profile: string }>;
  // Tear down the callback server (also triggered via the abort signal).
  cancel: () => void;
};

export type StartOAuthLoginOptions = {
  profile: string;
  signal: AbortSignal;
  // Injected for tests; defaults to the real clock.
  now?: () => number;
  home?: string;
  // When false, the browser is not auto-opened (the caller surfaces the link).
  // Defaults to true.
  openBrowser?: boolean;
};

export type OAuthLoginDeps<TTokens> = {
  startCallbackServer: (expectedState: string) => Promise<CallbackServer>;
  buildAuthorizeUrl: (pkce: Pkce, state: string) => string;
  exchangeCode: (code: string, verifier: string, now: number) => Promise<TTokens>;
  saveProfile: (
    profile: { name: string; tokens: TTokens; createdAt: number },
    home?: string,
  ) => Promise<void>;
};

// Drive the loopback PKCE login: start the callback server, build the authorize
// URL, and return a handle whose `completed` promise resolves after the browser
// round-trip and token exchange. The server is always closed, whether the flow
// succeeds, fails, or is aborted.
export async function startOAuthLogin<TTokens>(
  opts: StartOAuthLoginOptions,
  deps: OAuthLoginDeps<TTokens>,
): Promise<OAuthLoginHandle> {
  const now = opts.now ?? Date.now;
  const pkce = generatePkce();
  const state = generateState();
  const server = await deps.startCallbackServer(state);
  const authorizeUrl = deps.buildAuthorizeUrl(pkce, state);

  const completed = (async (): Promise<{ profile: string }> => {
    try {
      const code = await server.waitForCode(opts.signal);
      const tokens = await deps.exchangeCode(code, pkce.verifier, now());
      await deps.saveProfile({ name: opts.profile, tokens, createdAt: now() }, opts.home);
      return { profile: opts.profile };
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
