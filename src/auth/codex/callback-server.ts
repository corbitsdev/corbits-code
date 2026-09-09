// Codex callback server — see the shared factory in ./provider.ts.
import type { CallbackServer } from "../oauth/callback-server.js";
import { codexAuth } from "./provider.js";

export type CodexCallbackServer = CallbackServer;

export const startCodexCallbackServer = codexAuth.startCallbackServer;
