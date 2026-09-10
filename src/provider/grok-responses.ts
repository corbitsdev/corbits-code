import { responsesAdapterFactory } from "@corbits/openai-responses";
import { XAI_USER_ID_OPTION, xaiResponsesQuirks } from "@corbits/xai-provider";
import type { AdapterFactory } from "@intx/inference";

export const GROK_RESPONSES_PROVIDER = "grok-responses";

export const GROK_USER_ID_OPTION = "grokUserId";
export const GROK_SESSION_ID_OPTION = "grokSessionId";

// Spread xAI quirks and remap only host option keys. Config still writes
// grokUserId / grokSessionId / reasoning_effort; wrapping buildRequest to
// alias those would hide the mismatch instead of baking the host names.
export const createGrokResponsesAdapter: AdapterFactory =
  responsesAdapterFactory({
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
