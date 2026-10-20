import {
  startCallbackServer,
  type CallbackFailure,
  type CallbackServer,
} from "@corbits/oauth-core";

import {
  authorizationDoneHtml,
  callbackPageHtml,
  type CallbackPageCopy,
} from "./callback-page.js";

export type { CallbackServer };

function callbackFailureText(failure: CallbackFailure): string {
  if (failure.providerError !== undefined) return failure.providerError;
  if (failure.code === "state_mismatch") return "state mismatch";
  return "no code returned";
}

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
    failedHtml: (failure) =>
      callbackPageHtml(
        { subject: providerLabel, error: callbackFailureText(failure) },
        copy,
      ),
  });
}
