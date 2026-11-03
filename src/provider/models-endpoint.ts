import { type } from "arktype";

import { normalizeOpenAICompatibleBaseURL } from "../config/settings.js";

export const DEFAULT_MODELS_REQUEST_TIMEOUT_MS = 10_000;

export function modelsEndpointURL(baseURL: string): string {
  return (
    normalizeOpenAICompatibleBaseURL(baseURL).replace(/\/$/, "") + "/models"
  );
}

// One /models `{ data: [{ id }] }` shape shared by every discovery importer
// (model-catalogs, ollama) so the parsers cannot drift.
export const ModelsEndpointResponse = type({
  data: type({ id: "string" }).array(),
});

export type ModelsEndpointDiscoveryState =
  | {
      readonly status: "models";
      readonly models: readonly [string, ...string[]];
    }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "malformed"; readonly message: string };

// Single unknown→message coercion for discovery failure paths.
export function endpointErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a `/models` response body and project it to its discovery state.
 * Dedup happens by trimmed id; an optional cap rebrands an oversized catalog
 * as malformed instead of admitting it. Callers keep their own HTTP and
 * transport failure lines; this only owns the body.
 */
export function parseModelsData(
  raw: unknown,
  cap?: { readonly maxModels: number; readonly oversizeMessage: string },
): ModelsEndpointDiscoveryState {
  const parsed = ModelsEndpointResponse(raw);
  if (parsed instanceof type.errors) {
    return { status: "malformed", message: parsed.summary };
  }
  if (cap !== undefined && parsed.data.length > cap.maxModels) {
    return { status: "malformed", message: cap.oversizeMessage };
  }
  const [first, ...rest] = new Set(
    parsed.data.map(({ id }) => id.trim()).filter((id) => id.length > 0),
  );
  return first === undefined
    ? { status: "empty" }
    : { status: "models", models: [first, ...rest] };
}

// Single GET against an OpenAI-compatible /models endpoint, so URL
// normalization and the request timeout stay consistent across callers.
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
