/** Step tables, labels, and prompts for the provider setup flow. */

import { isOllamaProviderId } from "../../provider/ollama.js";
import type { ProviderChoice } from "./types.js";

export type ProviderField =
  | "name"
  | "baseURL"
  | "apiKey"
  | "model"
  | "contextWindow"
  | "maxTokens"
  | "temperature"
  | "topP";

/** One screen of the flow. `provider` and `model` can be pick-lists. */
export type SetupStep =
  | "provider"
  | "name"
  | "baseURL"
  | "apiKey"
  | "model"
  | "contextWindow"
  | "maxTokens"
  | "temperature"
  | "topP"
  | "efforts"
  | "defaultEffort"
  | "login";

/** Known-provider path: pick, name the instance, paste key, pick model. */
export const PRESET_STEPS: readonly SetupStep[] = [
  "provider",
  "name",
  "apiKey",
  "model",
];

/** Ollama is keyless and keeps its editable root URL visible before discovery. */
export const OLLAMA_STEPS: readonly SetupStep[] = [
  "provider",
  "name",
  "baseURL",
  "model",
];

/**
 * Subscription path: pick, name the account (reusing an existing name asks
 * before re-authorizing it), sign in through the browser, pick a model.
 */
export const OAUTH_STEPS: readonly SetupStep[] = [
  "provider",
  "name",
  "login",
  "model",
];

/** Unknown endpoint: the full manual form, still preceded by the pick-list. */
export const CUSTOM_STEPS: readonly SetupStep[] = [
  "provider",
  "name",
  "baseURL",
  "apiKey",
  "model",
  "contextWindow",
  "maxTokens",
  "temperature",
  "topP",
  "efforts",
  "defaultEffort",
];

export const STEP_LABELS: Record<SetupStep, string> = {
  provider: "provider",
  name: "provider name",
  baseURL: "base url",
  apiKey: "api key",
  model: "model",
  contextWindow: "context window",
  maxTokens: "max output tokens",
  temperature: "temperature",
  topP: "top p",
  efforts: "reasoning efforts",
  defaultEffort: "default effort",
  login: "sign in",
};

export const STEP_PROMPTS: Record<SetupStep, string> = {
  provider: "pick the provider you have a key or subscription for",
  name: "name this provider — you will see it in /model",
  baseURL:
    "paste the provider url — Ollama uses the server root; others may include /v1",
  apiKey: "paste the api key — leave blank for a keyless local endpoint",
  model: "pick the model to start with",
  contextWindow:
    "context window (tokens) — optional, leave blank to use the default",
  maxTokens: "max output tokens — optional, leave blank to use the default",
  temperature: "temperature (0..2) — optional; mutually exclusive with top p",
  topP: "top p (0..1) — optional; mutually exclusive with temperature",
  efforts:
    "toggle the reasoning effort levels this provider accepts — space toggles, enter continues",
  defaultEffort: "pick the default reasoning effort for new sessions",
  login: "authorize in the browser — this window waits for you",
};

/** Instruction for the multi-instance "name" step (OAuth and API-key). */
export function accountNamePrompt(choice: ProviderChoice): string {
  if (choice.oauth != null) {
    return `name this account — stored as ${choice.oauth}/<name>, and used again if you reconnect it`;
  }
  return `name this instance — stored as ${choice.id}/<name>, and used again if you reconnect it`;
}

// The "name" step names a whole provider on the custom path but a single
// account/instance on multi-instance first-class kinds (OAuth and API-key).
export function stepLabel(
  step: SetupStep,
  choice: ProviderChoice | null,
): string {
  if (step === "name" && choice !== null && !choice.custom)
    return "account name";
  return STEP_LABELS[step];
}

export function stepsFor(choice: ProviderChoice | null): readonly SetupStep[] {
  if (choice === null) return PRESET_STEPS;
  if (choice.custom) return CUSTOM_STEPS;
  if (isOllamaProviderId(choice.id)) return OLLAMA_STEPS;
  return choice.oauth !== null ? OAUTH_STEPS : PRESET_STEPS;
}

// Temperature and topP XOR on the wire; both steps stay listed so either
// can be filled, and skip/clear is navigation, not a range check.
export function skipTopPWhenTemperatureSet(temperature: string): boolean {
  return temperature.trim().length > 0;
}

export function nextSamplingStepIndex(
  steps: readonly SetupStep[],
  currentIndex: number,
  temperature: string,
): number {
  const next = currentIndex + 1;
  if (
    skipTopPWhenTemperatureSet(temperature) &&
    steps[currentIndex] === "temperature" &&
    steps[next] === "topP"
  ) {
    return next + 1;
  }
  return next;
}

export function previousSamplingStepIndex(
  steps: readonly SetupStep[],
  currentIndex: number,
  temperature: string,
): number {
  if (currentIndex <= 0) return 0;
  const prev = currentIndex - 1;
  if (skipTopPWhenTemperatureSet(temperature) && steps[prev] === "topP") {
    return Math.max(0, prev - 1);
  }
  return prev;
}

export function topPAfterTemperatureAdvance(
  temperature: string,
  topP: string,
): string {
  return skipTopPWhenTemperatureSet(temperature) ? "" : topP;
}
