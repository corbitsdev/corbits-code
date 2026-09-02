import { createDependencies, type Dependencies, type AdapterManifest } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import * as openaiCompatible from "./openai-compatible-adapter.js";
import * as opencodeGo from "./opencode-go-adapter.js";
import * as codexResponses from "./codex-responses-adapter.js";
import * as grokResponses from "./grok-responses-adapter.js";
import * as bifrostAdapter from "./bifrost-adapter.js";
import * as openaiResponses from "./openai-responses-adapter.js";
import { CODEX_RESPONSES_PROVIDER, withCodexContentTypeRepair } from "./codex-responses-adapter.js";
import { GROK_RESPONSES_PROVIDER } from "./grok-responses-adapter.js";
import { withReplaySanitizer } from "./replay-sanitizer.js";
import { OPENCODE_GO_PROVIDER_ID } from "../../packages/opencode-go/src/index.js";
import { BIFROST_PROVIDER } from "./bifrost-adapter.js";
import { OPENAI_RESPONSES_PROVIDER } from "./openai-responses-adapter.js";

// Corbits Code ships first-party adapters on top of the built-in provider set:
// openai-compatible and OpenCode Go chat-completions adapters, Codex/Grok
// responses, Bifrost, and generic openai-responses (OpenCode Go gpt-* Luna family).
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
    specifier: "codex-responses-adapter",
    export: "createCodexResponsesAdapter",
  },
  {
    provider: GROK_RESPONSES_PROVIDER,
    specifier: "grok-responses-adapter",
    export: "createGrokResponsesAdapter",
  },
  {
    provider: BIFROST_PROVIDER,
    specifier: "bifrost-adapter",
    export: "createBifrostAdapter",
  },
  {
    provider: OPENAI_RESPONSES_PROVIDER,
    specifier: "openai-responses-adapter",
    export: "createOpenAIResponsesAdapter",
  },
];

const localModules: Record<string, unknown> = {
  "openai-compatible-adapter": openaiCompatible,
  "opencode-go-adapter": opencodeGo,
  "codex-responses-adapter": codexResponses,
  "grok-responses-adapter": grokResponses,
  "bifrost-adapter": bifrostAdapter,
  "openai-responses-adapter": openaiResponses,
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
      .then(createDependencies)
      .then((deps) => ({
        ...deps,
        fetch: withCodexContentTypeRepair(deps.fetch),
      }));
  }
  return cached;
}
