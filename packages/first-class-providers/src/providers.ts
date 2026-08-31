import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_PROVIDER_ID,
} from "../../opencode-go/src/index.js";
import type { FirstClassProviderDef } from "./types.js";

const OPENAI_API_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "o3", "o4-mini"] as const;
const OPENAI_API_DEFAULT = "gpt-5.4";

/**
 * First-class providers shown in the models-surface Connect list.
 * Tier A order: dual-path OpenAI, OAuth xAI, Go/Zen, Z.AI, big three, Custom.
 */
export const FIRST_CLASS_PROVIDERS: readonly FirstClassProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    auth: "chooser",
    paths: [
      {
        id: "chatgpt",
        label: "ChatGPT — Login via Browser",
        auth: "oauth",
        oauth: "codex",
        providerId: "codex",
      },
      {
        id: "api",
        label: "OpenAI API — API key",
        auth: "api-key",
        baseURL: "https://api.openai.com/v1",
        models: OPENAI_API_MODELS,
        defaultModel: OPENAI_API_DEFAULT,
        authHint: "Paste your OpenAI API key (sk-...)",
        providerId: "openai",
      },
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    auth: "oauth",
    oauth: "xai",
  },
  {
    id: OPENCODE_GO_PROVIDER_ID,
    label: OPENCODE_GO_DISPLAY_NAME,
    auth: "api-key",
    baseURL: OPENCODE_GO_BASE_URL,
    models: OPENCODE_GO_MODEL_IDS,
    defaultModel: OPENCODE_GO_DEFAULT_MODEL,
    authHint: "OpenCode Go subscription — paste your API key from https://opencode.ai/auth",
    opencodeGo: true,
    billingProduct: "subscription",
  },
  {
    id: "zen",
    label: "OpenCode Zen",
    auth: "api-key",
    baseURL: "https://opencode.ai/zen/v1",
    models: [
      "gpt-5.4",
      "gpt-5.4-mini",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "gemini-3-flash",
      "gemini-3-pro",
    ],
    defaultModel: "claude-sonnet-4-5",
    authHint:
      "OpenCode Zen pay-as-you-go credits — paste your API key from https://opencode.ai/auth",
    billingProduct: "credits",
  },
  {
    id: "zai",
    label: "Z.AI Coding Plan",
    auth: "api-key",
    // Coding Plan OpenAI-compatible endpoint (not the general paas/v4 API).
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    models: ["glm-5.2", "glm-5.1", "glm-4.7"],
    defaultModel: "glm-5.2",
    authHint: "Paste your Z.AI Coding Plan API key from https://z.ai",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    auth: "api-key",
    baseURL: "https://api.anthropic.com",
    models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-4-5",
    authHint: "Paste your Anthropic API key (sk-ant-...)",
    anthropic: true,
  },
  {
    id: "google",
    label: "Google",
    auth: "api-key",
    // OpenAI-compatible Gemini endpoint.
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    defaultModel: "gemini-2.5-pro",
    authHint: "Paste your Google AI Studio API key",
  },
  {
    id: "ollama",
    label: "Ollama",
    auth: "keyless",
    baseURL: "http://localhost:11434",
    models: [],
    defaultModel: "",
    authHint: "Local provider — Ollama must be running",
  },
  {
    id: "custom",
    label: "Custom",
    auth: "custom",
    authHint: "Open the full form for any OpenAI-compatible endpoint",
  },
] as const;

/** Connect-list rows (same as FIRST_CLASS_PROVIDERS; explicit export for hosts). */
export function connectListProviders(): readonly FirstClassProviderDef[] {
  return FIRST_CLASS_PROVIDERS;
}

export function firstClassProviderById(id: string): FirstClassProviderDef | undefined {
  return FIRST_CLASS_PROVIDERS.find((p) => p.id === id);
}

/**
 * Resolve a chooser path into a form-seedable def (api-key path only).
 * OAuth paths should trigger login with path.oauth instead.
 */
export function firstClassPathAsProvider(
  def: FirstClassProviderDef,
  pathId: string,
): FirstClassProviderDef | undefined {
  const path = def.paths?.find((p) => p.id === pathId);
  if (path === undefined || path.auth !== "api-key") return undefined;
  return {
    id: path.providerId ?? def.id,
    label: path.label,
    auth: "api-key",
    ...(path.baseURL !== undefined ? { baseURL: path.baseURL } : {}),
    ...(path.models !== undefined ? { models: path.models } : {}),
    ...(path.defaultModel !== undefined ? { defaultModel: path.defaultModel } : {}),
    ...(path.authHint !== undefined ? { authHint: path.authHint } : {}),
    ...(def.anthropic === true ? { anthropic: true } : {}),
    ...(def.opencodeGo === true ? { opencodeGo: true } : {}),
    ...(def.billingProduct !== undefined ? { billingProduct: def.billingProduct } : {}),
  };
}
