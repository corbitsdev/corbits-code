import { startCallbackServer, type CallbackServer } from "@corbits/oauth-core";

import {
  authorizationDoneHtml,
  callbackPageHtml,
  type CallbackPageCopy,
} from "../callback-page.js";
import { XAI_CALLBACK_PATH, XAI_CALLBACK_PORT } from "./constants.js";

export type XaiCallbackServer = CallbackServer;

export async function startXaiCallbackServer(
  expectedState: string,
  copy: CallbackPageCopy,
): Promise<XaiCallbackServer> {
  return startCallbackServer(expectedState, {
    port: XAI_CALLBACK_PORT,
    host: "127.0.0.1",
    path: XAI_CALLBACK_PATH,
    doneHtml: authorizationDoneHtml("xAI", copy),
    failedHtml: (reason) =>
      callbackPageHtml({ subject: "xAI", error: reason }, copy),
  });
}
