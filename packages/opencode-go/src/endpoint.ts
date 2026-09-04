import { OPENCODE_GO_ANTHROPIC_BASE_URL, OPENCODE_GO_BASE_URL } from "./constants.js";
import { type GoProtocol, protocolForGoModel } from "./models.js";

export interface GoEndpoint {
  protocol: GoProtocol;
  /** Base URL for the selected protocol's adapter. */
  baseURL: string;
  /**
   * Adapter id expected by the host inference registry.
   * Hosts map these to concrete ProviderAdapters.
   */
  adapter: "openai-compatible" | "openai-responses" | "anthropic";
}

/**
 * Resolve how a Go model should be called. The local protocol map wins.
 * Live ids without a map entry default to chat-completions — no prefix
 * heuristics, no multi-protocol probe.
 */
export function resolveGoEndpoint(modelId: string): GoEndpoint {
  const protocol = protocolForGoModel(modelId) ?? "chat-completions";
  switch (protocol) {
    case "messages":
      return {
        protocol,
        baseURL: OPENCODE_GO_ANTHROPIC_BASE_URL,
        adapter: "anthropic",
      };
    case "responses":
      return {
        protocol,
        baseURL: OPENCODE_GO_BASE_URL,
        adapter: "openai-responses",
      };
    case "chat-completions":
      return {
        protocol,
        baseURL: OPENCODE_GO_BASE_URL,
        adapter: "openai-compatible",
      };
  }
}
