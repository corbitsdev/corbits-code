import {
  authorizationDoneHtml,
  startCallbackServer,
  type CallbackServer,
} from "../oauth/callback-server.js";
import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from "./constants.js";

export type XaiCallbackServer = CallbackServer;

export async function startXaiCallbackServer(expectedState: string): Promise<XaiCallbackServer> {
  return startCallbackServer(expectedState, {
    port: XAI_CALLBACK_PORT,
    path: XAI_CALLBACK_PATH,
    doneHtml: authorizationDoneHtml("xAI"),
    label: "xAI",
  });
}
