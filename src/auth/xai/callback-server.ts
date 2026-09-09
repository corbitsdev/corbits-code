// xAI callback server — see the shared factory in ./provider.ts.
import type { CallbackServer } from "../oauth/callback-server.js";
import { xaiAuth } from "./provider.js";

export type XaiCallbackServer = CallbackServer;

export const startXaiCallbackServer = xaiAuth.startCallbackServer;
