import {
  OPENCODE_GO_AUTH_HINT,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL,
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODEL_IDS,
  OPENCODE_GO_PROVIDER_ID,
} from "../../opencode-go/src/index.js";
import type { FirstClassProviderDef } from "./types.js";

/**
 * First-class providers shown in the models-surface Connect list.
 * Order matches product preference: subscription OAuth first, then API keys.
 */
export const FIRST_CLASS_PROVIDERS: readonly FirstClassProviderDef[] = [
  {
    id: "codex",
    label: "OpenAI Codex",
    auth: "oauth",
    oauth: "codex",
  },
  {
    id: "xai",
    label: "xAI Grok",
    auth: "oauth",
    oauth: "xai",
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
    authHint: "Paste your OpenCode Zen API key from https://opencode.ai/auth",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    auth: "api-key",
    baseURL: "https://api.anthropic.com",
    models: [
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ],
    defaultModel: "claude-sonnet-4-5",
    authHint: "Paste your Anthropic API key (sk-ant-...)",
    anthropic: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    auth: "api-key",
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "o3", "o4-mini"],
    defaultModel: "gpt-5.4",
    authHint: "Paste your OpenAI API key (sk-...)",
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
    id: OPENCODE_GO_PROVIDER_ID,
    label: OPENCODE_GO_DISPLAY_NAME,
    auth: "api-key",
    baseURL: OPENCODE_GO_BASE_URL,
    models: OPENCODE_GO_MODEL_IDS,
    defaultModel: OPENCODE_GO_DEFAULT_MODEL,
    authHint: OPENCODE_GO_AUTH_HINT,
  },
] as const;

export function firstClassProviderById(id: string): FirstClassProviderDef | undefined {
  return FIRST_CLASS_PROVIDERS.find((p) => p.id === id);
}
