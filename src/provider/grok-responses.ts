import { responsesAdapterFactory } from "@corbits/openai-responses";
import { XAI_USER_ID_OPTION, xaiResponsesQuirks } from "@corbits/xai-provider";
import type { AdapterFactory } from "@intx/inference";
import { withArgumentsFromDone } from "./codex-responses.js";

export const GROK_RESPONSES_PROVIDER = "grok-responses";

export const GROK_USER_ID_OPTION = "grokUserId";
export const GROK_SESSION_ID_OPTION = "grokSessionId";

// Spread xAI quirks and remap only host option keys. Config still writes
// grokUserId / grokSessionId / reasoning_effort; aliasing those in a
// buildRequest wrapper would hide the mismatch instead of baking the host
// names.
const baseFactory = responsesAdapterFactory({
  ...xaiResponsesQuirks,
  sessionIdOption: GROK_SESSION_ID_OPTION,
  headers: {
    ...xaiResponsesQuirks.headers,
    fromOption: (xaiResponsesQuirks.headers?.fromOption ?? []).map((entry) =>
      entry.optionKey === XAI_USER_ID_OPTION
        ? { ...entry, optionKey: GROK_USER_ID_OPTION }
        : entry,
    ),
  },
  reasoning: {
    ...xaiResponsesQuirks.reasoning,
    effortOption: "reasoning_effort",
  },
});

export const createGrokResponsesAdapter: AdapterFactory = (source) =>
  withArgumentsFromDone(baseFactory(source));
