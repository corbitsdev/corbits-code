import {
  startProviderCallbackServer,
  type CallbackServer,
} from "../provider-callback-server.js";

import type { CallbackPageCopy } from "../callback-page.js";
import {
  CODEX_CALLBACK_HOST,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from "./constants.js";

export type CodexCallbackServer = CallbackServer;

// Codex registers a fixed loopback redirect on port 1455; the authorization
// server only accepts this exact redirect_uri for this client.
export async function startCodexCallbackServer(
  expectedState: string,
  copy: CallbackPageCopy,
): Promise<CodexCallbackServer> {
  return startProviderCallbackServer(
    "Codex",
    {
      port: CODEX_CALLBACK_PORT,
      // Codex's registered redirect_uri uses localhost (not 127.0.0.1).
      host: CODEX_CALLBACK_HOST,
      path: CODEX_CALLBACK_PATH,
    },
    expectedState,
    copy,
  );
}
