// Resolve the Zen endpoint + provider adapter from the protocol map.
// Mirrors the OpenCode Go endpoint module; Go paths are untouched.

import { ZEN_BASE_URL, ZEN_DEFAULT_BASE_URL } from "./constants.js";
import { protocolForZenModel, type ZenProtocol } from "./models.js";

export type ZenEndpointKind =
  | "anthropic"
  | "openai-compatible"
  | "openai-responses";

export interface ZenEndpoint {
  baseURL: string;
  adapter: ZenEndpointKind;
}

const ENDPOINT_BY_PROTOCOL: Record<ZenProtocol, ZenEndpoint> = {
  messages: { baseURL: ZEN_BASE_URL, adapter: "anthropic" },
  responses: { baseURL: ZEN_DEFAULT_BASE_URL, adapter: "openai-responses" },
  "chat-completions": {
    baseURL: ZEN_DEFAULT_BASE_URL,
    adapter: "openai-compatible",
  },
};

/** Map hit if and only if this model pins Zen protocol selection. */
export function zenProtocolForModel(model: string): ZenProtocol {
  return protocolForZenModel(model);
}

/** Route a Zen model to its endpoint. Unknown ids stay on chat completions. */
export function resolveZenEndpoint(model: string): ZenEndpoint {
  return ENDPOINT_BY_PROTOCOL[zenProtocolForModel(model)];
}
