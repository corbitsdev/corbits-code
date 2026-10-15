import { type } from "arktype";
import {
  createCodexResponsesAdapter as createPackageCodexResponsesAdapter,
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_REASONING_EFFORT_OPTION,
  CODEX_SESSION_ID_OPTION,
  withCodexContentTypeRepair,
} from "@corbits/codex-provider";
import type { AdapterFactory, ProviderAdapter } from "@intx/inference";
import type { InferenceOptions } from "@intx/types/runtime";
import { withJsonBodyRewrite } from "./adapter-decorators.js";
import { ENVIRONMENT_TAG_NAME, PRODUCT_NAME } from "../branding.js";

export const CODEX_RESPONSES_PROVIDER = "codex-responses";

export {
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_SESSION_ID_OPTION,
  withCodexContentTypeRepair,
};

const CODEX_QUIRKS = {
  productName: PRODUCT_NAME,
  environmentTagName: ENVIRONMENT_TAG_NAME,
};

const HOST_REASONING_EFFORT_OPTION = "reasoning_effort";

function remapReasoningEffort(options: InferenceOptions): InferenceOptions {
  const providerOptions = options.providerOptions;
  if (providerOptions === undefined) return options;
  const hostEffort = providerOptions[HOST_REASONING_EFFORT_OPTION];
  if (
    hostEffort === undefined ||
    providerOptions[CODEX_REASONING_EFFORT_OPTION] !== undefined
  ) {
    return options;
  }
  return {
    ...options,
    providerOptions: {
      ...providerOptions,
      [CODEX_REASONING_EFFORT_OPTION]: hostEffort,
    },
  };
}

function withHostReasoningEffort(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    buildRequest: (messages, model, options) =>
      adapter.buildRequest(messages, model, remapReasoningEffort(options)),
  };
}

const FunctionCallItemDone = type({
  type: "'response.output_item.done'",
  item: { type: "'function_call'", call_id: "string", arguments: "string" },
});

// With parallel calls on, some Codex backends send a call's arguments only on
// output_item.done and never as deltas. The packaged parser reads deltas
// alone, so without this replay the harness assembles those calls as `{}`
// (CL-10582).
function withArgumentsFromDone(adapter: ProviderAdapter): ProviderAdapter {
  let indexByCallId = new Map<string, number>();
  let streamedIndices = new Set<number>();
  return {
    ...adapter,
    buildRequest: (messages, model, options) => {
      indexByCallId = new Map();
      streamedIndices = new Set();
      return adapter.buildRequest(messages, model, options);
    },
    parseResponse: (sseData) => {
      const events = adapter.parseResponse(sseData);
      for (const event of events) {
        if (event.type === "inference.tool_call.start") {
          if (event.data.index !== undefined) {
            indexByCallId.set(event.data.callId, event.data.index);
          }
        } else if (event.type === "inference.tool_call.delta") {
          if (event.data.index !== undefined) {
            streamedIndices.add(event.data.index);
          }
        }
      }
      if (!sseData.includes('"response.output_item.done"')) return events;
      const done = FunctionCallItemDone(JSON.parse(sseData));
      if (done instanceof type.errors || done.item.arguments.length === 0) {
        return events;
      }
      const index = indexByCallId.get(done.item.call_id);
      if (index === undefined || streamedIndices.has(index)) return events;
      streamedIndices.add(index);
      return [
        ...events,
        {
          type: "inference.tool_call.delta",
          seq: 0,
          data: {
            callId: String(index),
            argumentFragment: done.item.arguments,
            partial: { text: "" },
            index,
          },
        },
      ];
    },
  };
}

// CodexQuirks are required by the package factory; Responses option keys are
// not part of that bag, so host reasoning_effort is aliased at buildRequest.
// The parallel_tool_calls rewrite exists because the packaged adapter pins
// false while the reactor already fans out a multi-call batch concurrently.
export const createCodexResponsesAdapter: AdapterFactory = (source) =>
  withHostReasoningEffort(
    withJsonBodyRewrite(
      withArgumentsFromDone(
        createPackageCodexResponsesAdapter(source, CODEX_QUIRKS),
      ),
      // Codex accepts parallel_tool_calls:true; pin the field on the wire.
      (body) => {
        body["parallel_tool_calls"] = true;
        return true;
      },
    ),
  );
