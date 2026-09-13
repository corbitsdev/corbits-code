import {
  createCodexResponsesAdapter as createPackageCodexResponsesAdapter,
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_REASONING_EFFORT_OPTION,
  CODEX_SESSION_ID_OPTION,
  withCodexContentTypeRepair,
} from "@corbits/codex-provider";
import type { AdapterFactory, ProviderAdapter } from "@intx/inference";
import type { InferenceOptions } from "@intx/types/runtime";
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

// CL-7420 probe: the ChatGPT Codex backend accepts parallel_tool_calls:true
// (HTTP 200 on POST /codex/responses, echoed true in response.created). The
// packaged adapter still pins false, so the host rewrites the field on the
// wire; the reactor already fans out a multi-call batch concurrently.
function withParallelToolCalls(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    buildRequest: (messages, model, options) => {
      const request = adapter.buildRequest(messages, model, options);
      const body = JSON.parse(request.body) as Record<string, unknown>;
      body["parallel_tool_calls"] = true;
      return { ...request, body: JSON.stringify(body) };
    },
  };
}

// CodexQuirks are required by the package factory; Responses option keys are
// not part of that bag, so host reasoning_effort is aliased at buildRequest.
export const createCodexResponsesAdapter: AdapterFactory = (source) =>
  withHostReasoningEffort(
    withParallelToolCalls(
      createPackageCodexResponsesAdapter(source, CODEX_QUIRKS),
    ),
  );
