import {
  startProviderCallbackServer,
  type CallbackServer,
} from "../provider-callback-server.js";

import type { CallbackPageCopy } from "../callback-page.js";
import {
  XAI_CALLBACK_HOST,
  XAI_CALLBACK_PATH,
  XAI_CALLBACK_PORT,
} from "./constants.js";

export type XaiCallbackServer = CallbackServer;

export async function startXaiCallbackServer(
  expectedState: string,
  copy: CallbackPageCopy,
): Promise<XaiCallbackServer> {
  return startProviderCallbackServer(
    "xAI",
    {
      port: XAI_CALLBACK_PORT,
      host: XAI_CALLBACK_HOST,
      path: XAI_CALLBACK_PATH,
    },
    expectedState,
    copy,
  );
}
