import { type } from "arktype";

import { normalizeOpenAICompatibleBaseURL } from "../config/settings.js";

export const DEFAULT_MODELS_REQUEST_TIMEOUT_MS = 10_000;

export function modelsEndpointURL(baseURL: string): string {
  return (
    normalizeOpenAICompatibleBaseURL(baseURL).replace(/\/$/, "") + "/models"
  );
}

// One /models `{ data: [{ id }] }` shape shared by every discovery importer
// (bounded-model-catalog, ollama) so the parsers cannot drift.
export const ModelsEndpointResponse = type({
  data: type({ id: "string" }).array(),
});

export type ModelsEndpointDiscoveryState =
  | { readonly status: "models"; readonly models: readonly string[] }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "malformed"; readonly message: string };

// Single unknown→message coercion for discovery failure paths.
export function endpointErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Single GET against an OpenAI-compatible /models endpoint. Every caller that
// probes a provider's model list goes through here so URL normalization and
// the request timeout stay consistent.
export async function requestModelsEndpoint(args: {
  baseURL: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Response> {
  const timeout = AbortSignal.timeout(
    args.timeoutMs ?? DEFAULT_MODELS_REQUEST_TIMEOUT_MS,
  );
  return fetch(modelsEndpointURL(args.baseURL), {
    method: "GET",
    headers: args.headers ?? {},
    signal:
      args.signal === undefined
        ? timeout
        : AbortSignal.any([args.signal, timeout]),
  });
}
