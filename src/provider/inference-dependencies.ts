import { createDependencies, type Dependencies, type AdapterManifest } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import * as openaiCompatible from "./openai-compatible-adapter.js";
import * as codexResponses from "./codex-responses-adapter.js";
import * as grokResponses from "./grok-responses-adapter.js";
import * as bifrostAdapter from "./bifrost-adapter.js";
import { CODEX_RESPONSES_PROVIDER } from "./codex-responses-adapter.js";
import { GROK_RESPONSES_PROVIDER } from "./grok-responses-adapter.js";
import { BIFROST_PROVIDER } from "./bifrost-adapter.js";

// Corbits Code ships three first-party adapters on top of the built-in provider
// set: a providerOptions-aware "openai-compatible" override, plus the Codex and
// Grok responses adapters. The interchange runtime resolves adapters through an
// injected registry rather than a mutable global, so we describe ours as a
// manifest and feed it a local importer — the registry keeps its dynamic-import
// contract while these stay statically linked into the bundle.
const manifest: AdapterManifest = [
  {
    provider: "openai-compatible",
    specifier: "openai-compatible-adapter",
    export: "createOpenAICompatibleAdapter",
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
];

const localModules: Record<string, unknown> = {
  "openai-compatible-adapter": openaiCompatible,
  "codex-responses-adapter": codexResponses,
  "grok-responses-adapter": grokResponses,
	  "bifrost-adapter": bifrostAdapter,
};

let cached: Promise<Dependencies> | undefined;

// The registry is built from pure factories and holds no per-call state, so a
// single instance is shared across the primary agent, sub-agents, and the
// compaction summarizer — every inference path resolves the same provider set.
export function createInferenceDependencies(): Promise<Dependencies> {
  if (cached === undefined) {
    cached = loadAdapterRegistry(manifest, {
      import: (specifier) => Promise.resolve(localModules[specifier]),
    }).then(createDependencies);
  }
  return cached;
}
