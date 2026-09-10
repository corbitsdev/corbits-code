import { responsesAdapterFactory, type ResponsesQuirks } from "@corbits/openai-responses";
import type { AdapterFactory } from "@intx/inference";
import { OPENCODE_SESSION_ID_OPTION } from "./opencode-session.js";

export const OPENAI_RESPONSES_PROVIDER = "openai-responses";

export const OPENAI_SESSION_ID_OPTION = "openaiSessionId";

// Baked at the host so OpenCode Go Responses does not read source.quirks
// (package createOpenAIResponsesAdapter would, and that is not the current Go wire).
const hostQuirks: ResponsesQuirks = {
  path: "/responses",
  sessionIdOption: OPENAI_SESSION_ID_OPTION,
  headers: {
    fromOption: [{ optionKey: OPENCODE_SESSION_ID_OPTION, header: "x-opencode-session" }],
  },
  systemPrompt: { role: "system", shape: "string" },
  contentShape: "flat",
  reasoning: { summary: "auto" },
};

export const createOpenAIResponsesAdapter: AdapterFactory = responsesAdapterFactory(hostQuirks);
