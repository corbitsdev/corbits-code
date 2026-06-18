import { openInBrowser } from "../codex/login.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "./constants.js";
import { startXaiCallbackServer } from "./callback-server.js";
import { buildAuthorizeUrl, exchangeCode } from "./oauth.js";
import { generatePkce, generateState } from "./pkce.js";
import { saveXaiProfile } from "./store.js";

export type XaiLoginHandle = {
  authorizeUrl: string;
  completed: Promise<{ profile: string }>;
  cancel: () => void;
};

export type StartXaiLoginOptions = {
  profile: string;
  signal: AbortSignal;
  now?: () => number;
  home?: string;
  openBrowser?: boolean;
};

export async function startXaiLogin(opts: StartXaiLoginOptions): Promise<XaiLoginHandle> {
  const now = opts.now ?? Date.now;
  const pkce = generatePkce();
  const state = generateState();
  const server = await startXaiCallbackServer(state);
  const authorizeUrl = buildAuthorizeUrl(pkce, state);

  const completed = (async (): Promise<{ profile: string }> => {
    try {
      const code = await server.waitForCode(opts.signal);
      const tokens = await exchangeCode(code, pkce.verifier, now());
      await saveXaiProfile({ name: opts.profile, tokens, createdAt: now() }, opts.home);
      return { profile: opts.profile };
    } finally {
      server.close();
    }
  })();
  completed.catch(() => undefined);

  if (opts.openBrowser !== false) openInBrowser(authorizeUrl);

  return {
    authorizeUrl,
    completed,
    cancel: () => server.close(),
  };
}

export const xaiProviderSurface = {
  baseURL: XAI_BASE_URL,
  models: [...XAI_DEFAULT_MODELS],
} as const;
