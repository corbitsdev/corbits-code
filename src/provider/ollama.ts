import { type } from "arktype";

import { requestModelsEndpoint } from "./models-endpoint.js";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_DEFAULT_ROOT_URL = "http://localhost:11434";

export function isOllamaProviderId(providerId: string): boolean {
  return providerId === OLLAMA_PROVIDER_ID || providerId.startsWith(`${OLLAMA_PROVIDER_ID}/`);
}

/** Validate and normalize the server root persisted by Ollama setup. */
export function normalizeOllamaRootURL(rootURL: string): string {
  const parsed = new URL(rootURL.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid Ollama URL "${rootURL}": expected http or https.`);
  }
  if (parsed.pathname !== "/") {
    throw new Error(`Invalid Ollama URL "${rootURL}": expected a server root without a path.`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

/** Project an editable Ollama root URL to its OpenAI-compatible API endpoint. */
export function ollamaOpenAIBaseURL(rootURL: string): string {
  return `${normalizeOllamaRootURL(rootURL)}/v1`;
}

const OllamaModelsResponse = type({
  data: type({ id: "string" }).array(),
});

export type OllamaDiscoveryState =
  | { readonly status: "models"; readonly models: readonly string[] }
  | { readonly status: "empty" }
  | { readonly status: "unavailable"; readonly message: string }
  | { readonly status: "malformed"; readonly message: string };

/** Discover installed Ollama models without leaking transport or parsing failures. */
export async function discoverOllamaModels(args: {
  rootURL: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<OllamaDiscoveryState> {
  let baseURL: string;
  try {
    baseURL = ollamaOpenAIBaseURL(args.rootURL);
  } catch (error) {
    return {
      status: "malformed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let response: Response;
  try {
    response = await requestModelsEndpoint({
      baseURL,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return { status: "unavailable", message: `Ollama returned HTTP ${String(response.status)}` };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    return {
      status: "malformed",
      message: error instanceof Error ? error.message : "Ollama returned invalid JSON",
    };
  }
  const parsed = OllamaModelsResponse(raw);
  if (parsed instanceof type.errors) {
    return { status: "malformed", message: parsed.summary };
  }
  const models = [...new Set(parsed.data.map(({ id }) => id.trim()).filter((id) => id.length > 0))];
  return models.length > 0 ? { status: "models", models } : { status: "empty" };
}
