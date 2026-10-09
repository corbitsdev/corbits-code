import {
  createDependencies,
  type Dependencies,
  type AdapterManifest,
} from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import * as openaiCompatible from "./openai-compatible-adapter.js";
import * as opencodeGo from "./opencode-go-adapter.js";
import * as codexResponses from "./codex-responses.js";
import * as grokResponses from "./grok-responses.js";
import * as bifrostAdapter from "./bifrost-adapter.js";
import * as deepseekV4 from "./deepseek-v4-adapter.js";
import * as openaiResponses from "./openai-responses.js";
import * as anthropicSession from "./anthropic-session-adapter.js";
import {
  CODEX_RESPONSES_PROVIDER,
  withCodexContentTypeRepair,
} from "./codex-responses.js";
import { GROK_RESPONSES_PROVIDER } from "./grok-responses.js";
import { withAnthropicCacheBreakpoint } from "./anthropic-cache-breakpoint.js";
import { withReplaySanitizer } from "./replay-sanitizer.js";
import { isPollOnlyPendingBatch } from "../subagent/poll-exempt.js";
import { OPENCODE_GO_PROVIDER_ID } from "../../packages/opencode-go/src/index.js";
import { BIFROST_PROVIDER } from "./bifrost-adapter.js";
import { DEEPSEEK_V4_PROVIDER } from "./deepseek-v4-adapter.js";
import { OPENAI_RESPONSES_PROVIDER } from "./openai-responses.js";
import {
  OPENCODE_GO_MESSAGES_PROVIDER,
  ZEN_MESSAGES_PROVIDER,
} from "./anthropic-session-adapter.js";

// Corbits Code ships first-party adapters on top of the built-in provider set:
// openai-compatible and OpenCode Go chat-completions adapters, Codex/Grok
// responses, Bifrost, generic openai-responses (OpenCode Go gpt-* Luna family),
// the OpenCode Go Anthropic messages adapter, and the Zen Anthropic messages
// adapter.
const manifest: AdapterManifest = [
  {
    provider: "openai-compatible",
    specifier: "openai-compatible-adapter",
    export: "createOpenAICompatibleAdapter",
  },
  {
    provider: OPENCODE_GO_PROVIDER_ID,
    specifier: "opencode-go-adapter",
    export: "createOpenCodeGoAdapter",
  },
  {
    provider: CODEX_RESPONSES_PROVIDER,
    specifier: "codex-responses",
    export: "createCodexResponsesAdapter",
  },
  {
    provider: GROK_RESPONSES_PROVIDER,
    specifier: "grok-responses",
    export: "createGrokResponsesAdapter",
  },
  {
    provider: BIFROST_PROVIDER,
    specifier: "bifrost-adapter",
    export: "createBifrostAdapter",
  },
  {
    provider: DEEPSEEK_V4_PROVIDER,
    specifier: "deepseek-v4-adapter",
    export: "createDeepSeekV4Adapter",
  },
  {
    provider: OPENAI_RESPONSES_PROVIDER,
    specifier: "openai-responses",
    export: "createOpenAIResponsesAdapter",
  },
  {
    provider: OPENCODE_GO_MESSAGES_PROVIDER,
    specifier: "anthropic-session-adapter",
    export: "createOpenCodeGoAnthropicAdapter",
  },
  {
    provider: ZEN_MESSAGES_PROVIDER,
    specifier: "anthropic-session-adapter",
    export: "createZenAnthropicAdapter",
  },
];

const localModules: Record<string, unknown> = {
  "openai-compatible-adapter": openaiCompatible,
  "opencode-go-adapter": opencodeGo,
  "codex-responses": codexResponses,
  "grok-responses": grokResponses,
  "bifrost-adapter": bifrostAdapter,
  "deepseek-v4-adapter": deepseekV4,
  "openai-responses": openaiResponses,
  "anthropic-session-adapter": anthropicSession,
};

let cached: Promise<Dependencies> | undefined;

// The registry is built from pure factories and holds no per-call state, so a
// single instance is shared across the primary agent, sub-agents, and the
// compaction summarizer — every inference path resolves the same provider set.
export function createInferenceDependencies(): Promise<Dependencies> {
  if (cached === undefined) {
    cached = loadAdapterRegistry(manifest, {
      import: (specifier) => Promise.resolve(localModules[specifier]),
    })
      .then(withReplaySanitizer)
      .then(withAnthropicCacheBreakpoint)
      .then(createDependencies)
      .then((deps) => ({
        ...deps,
        fetch: withCodexContentTypeRepair(deps.fetch),
        isPollOnlyPendingBatch,
      }));
  }
  return cached;
}
