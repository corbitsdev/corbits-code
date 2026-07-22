import {
  authorizationDoneHtml,
  startCallbackServer,
  type CallbackServer,
} from "../oauth/callback-server.js";
import { CODEX_CALLBACK_PATH, CODEX_CALLBACK_PORT } from "./constants.js";

export type CodexCallbackServer = CallbackServer;

// Codex registers a fixed loopback redirect on port 1455; the authorization
// server only accepts this exact redirect_uri for this client.
export async function startCodexCallbackServer(expectedState: string): Promise<CodexCallbackServer> {
  return startCallbackServer(expectedState, {
    port: CODEX_CALLBACK_PORT,
    path: CODEX_CALLBACK_PATH,
    // Codex's registered redirect_uri uses localhost (not 127.0.0.1).
    publicHost: "localhost",
    doneHtml: authorizationDoneHtml("Codex"),
    label: "Codex",
  });
}
