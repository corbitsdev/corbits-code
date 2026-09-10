import { startCallbackServer, type CallbackServer } from "@corbits/oauth-core";

import {
  authorizationDoneHtml,
  callbackPageHtml,
  type CallbackPageCopy,
} from "../callback-page.js";
import { CODEX_CALLBACK_PATH, CODEX_CALLBACK_PORT } from "./constants.js";

export type CodexCallbackServer = CallbackServer;

// Codex registers a fixed loopback redirect on port 1455; the authorization
// server only accepts this exact redirect_uri for this client.
export async function startCodexCallbackServer(
  expectedState: string,
  copy: CallbackPageCopy,
): Promise<CodexCallbackServer> {
  return startCallbackServer(expectedState, {
    port: CODEX_CALLBACK_PORT,
    // Codex's registered redirect_uri uses localhost (not 127.0.0.1).
    host: "localhost",
    path: CODEX_CALLBACK_PATH,
    doneHtml: authorizationDoneHtml("Codex", copy),
    failedHtml: (reason) =>
      callbackPageHtml({ subject: "Codex", error: reason }, copy),
  });
}
