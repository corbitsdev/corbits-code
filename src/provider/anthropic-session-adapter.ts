import { type ProviderAdapter } from "@intx/inference";
import { createAnthropicAdapter } from "@intx/inference/providers";
import {
  OPENCODE_SESSION_ID_OPTION,
  optionString,
} from "./opencode-session.js";
import { withExtraHeaders } from "./adapter-decorators.js";

export const ZEN_MESSAGES_PROVIDER = "zen-messages";
export const OPENCODE_GO_MESSAGES_PROVIDER = "opencode-go-messages";

type AdapterSource = Parameters<typeof createAnthropicAdapter>[0];

export function createSessionHeaderAnthropicAdapter(
  source: AdapterSource,
  quirks?: unknown,
): ProviderAdapter {
  return withExtraHeaders(
    createAnthropicAdapter(source, quirks),
    ({ options }) => {
      // Operator-visible turn continuity on the shared messages gateways.
      const sessionId = optionString(options, OPENCODE_SESSION_ID_OPTION);
      return sessionId === undefined ? {} : { "x-opencode-session": sessionId };
    },
  );
}

// Both providers share the session-header wrapper above; keep both export
// names for the adapter registration table.
export const createZenAnthropicAdapter = createSessionHeaderAnthropicAdapter;

export const createOpenCodeGoAnthropicAdapter =
  createSessionHeaderAnthropicAdapter;
