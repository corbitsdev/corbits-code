import { normalizeOpenAICompatibleBaseURL } from "../config/settings.js";

export const DEFAULT_MODELS_REQUEST_TIMEOUT_MS = 10_000;

export function modelsEndpointURL(baseURL: string): string {
  return normalizeOpenAICompatibleBaseURL(baseURL).replace(/\/$/, "") + "/models";
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
  const timeout = AbortSignal.timeout(args.timeoutMs ?? DEFAULT_MODELS_REQUEST_TIMEOUT_MS);
  return fetch(modelsEndpointURL(args.baseURL), {
    method: "GET",
    headers: args.headers ?? {},
    signal: args.signal === undefined ? timeout : AbortSignal.any([args.signal, timeout]),
  });
}
