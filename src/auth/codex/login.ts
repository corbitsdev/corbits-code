import { spawn } from "node:child_process";
import { platform } from "node:os";

import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "./constants.js";
import { startCodexCallbackServer } from "./callback-server.js";
import { buildAuthorizeUrl, exchangeCode } from "./oauth.js";
import { generatePkce, generateState } from "./pkce.js";
import { saveCodexProfile } from "./store.js";

// Best-effort: open the authorization URL in the user's default browser. Never
// throws — a headless box or missing opener just means the user opens the
// surfaced link manually. Detached + unref so the opener cannot keep the
// process alive.
export function openInBrowser(url: string): void {
  const command =
    platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening the browser is a convenience; the copyable link is the fallback.
  }
}

export type CodexLoginHandle = {
  // The URL to authorize at — surfaced as a copyable link in the TUI and also
  // handed to the browser opener.
  authorizeUrl: string;
  // Resolves once the user completes consent and tokens are stored, or rejects
  // on error/abort. The resolved name echoes the profile that was saved.
  completed: Promise<{ profile: string }>;
  // Tear down the callback server (also triggered via the abort signal).
  cancel: () => void;
};

export type StartCodexLoginOptions = {
  profile: string;
  signal: AbortSignal;
  // Injected for tests; defaults to the real clock.
  now?: () => number;
  home?: string;
  // When false, the browser is not auto-opened (the caller surfaces the link).
  // Defaults to true.
  openBrowser?: boolean;
};

// Drive the loopback PKCE login: start the callback server, build the authorize
// URL, and return a handle whose `completed` promise resolves after the browser
// round-trip and token exchange. The server is always closed, whether the flow
// succeeds, fails, or is aborted.
export async function startCodexLogin(opts: StartCodexLoginOptions): Promise<CodexLoginHandle> {
  const now = opts.now ?? Date.now;
  const pkce = generatePkce();
  const state = generateState();
  const server = await startCodexCallbackServer();
  const authorizeUrl = buildAuthorizeUrl(pkce, state);

  const completed = (async (): Promise<{ profile: string }> => {
    try {
      const code = await server.waitForCode(state, opts.signal);
      const tokens = await exchangeCode(code, pkce.verifier, now());
      await saveCodexProfile(
        { name: opts.profile, tokens, createdAt: now() },
        opts.home,
      );
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

// Metadata describing the Codex provider surface, used when projecting a logged
// in profile into the provider catalog.
export const codexProviderSurface = {
  baseURL: CODEX_BASE_URL,
  models: [...CODEX_DEFAULT_MODELS],
} as const;
