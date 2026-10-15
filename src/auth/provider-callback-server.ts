import { startCallbackServer, type CallbackServer } from "@corbits/oauth-core";

import {
  authorizationDoneHtml,
  callbackPageHtml,
  type CallbackPageCopy,
} from "./callback-page.js";

export type { CallbackServer };

export interface ProviderCallbackServerConfig {
  port: number;
  host?: string | undefined;
  path: string;
}

export async function startProviderCallbackServer(
  providerLabel: string,
  config: ProviderCallbackServerConfig,
  expectedState: string,
  copy: CallbackPageCopy,
): Promise<CallbackServer> {
  return startCallbackServer(expectedState, {
    port: config.port,
    // exactOptionalPropertyTypes: host only rides when a provider selects one.
    ...(config.host === undefined ? {} : { host: config.host }),
    path: config.path,
    doneHtml: authorizationDoneHtml(providerLabel, copy),
    failedHtml: (reason) =>
      callbackPageHtml({ subject: providerLabel, error: reason }, copy),
  });
}
