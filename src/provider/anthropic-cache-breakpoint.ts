import type {
  AdapterRegistry,
  BuiltRequest,
  ExtendedInferenceOptions,
  ProviderAdapter,
} from "@intx/inference";
import {
  OPENCODE_GO_MESSAGES_PROVIDER,
  ZEN_MESSAGES_PROVIDER,
} from "./anthropic-session-adapter.js";

const ANTHROPIC_MESSAGES_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  ZEN_MESSAGES_PROVIDER,
  OPENCODE_GO_MESSAGES_PROVIDER,
]);

type WireBlock = Record<string, unknown>;

type WireMessage = {
  role?: unknown;
  content?: unknown;
};

function ephemeralSuffixLength(options: ExtendedInferenceOptions): number {
  // Every ephemeral turn is suffix, including mid-conversation `role: "system"`
  // injects. Role choice is ephemeralInjectRole; this wrapper only moves the
  // cache breakpoint before that suffix.
  return options.ephemeralTurns?.length ?? 0;
}

function isWireBlock(block: unknown): block is WireBlock {
  return typeof block === "object" && block !== null;
}

function stripBreakpoints(messages: WireMessage[], from: number): void {
  for (const message of messages.slice(from)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isWireBlock(block)) delete block.cache_control;
    }
  }
}

function placeBreakpoint(messages: WireMessage[], before: number): boolean {
  for (let index = before - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") continue;
    if (!Array.isArray(message?.content) || message.content.length === 0) {
      continue;
    }
    const last = message.content[message.content.length - 1];
    if (!isWireBlock(last)) continue;
    last.cache_control = { type: "ephemeral" };
    return true;
  }
  return false;
}

function moveBreakpointToPersistedTail(
  built: BuiltRequest,
  options: ExtendedInferenceOptions,
): BuiltRequest {
  const suffix = ephemeralSuffixLength(options);
  if (suffix === 0) return built;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(built.body) as Record<string, unknown>;
  } catch {
    return built;
  }
  if (!Array.isArray(body.messages)) return built;
  const messages = body.messages as WireMessage[];
  const split = messages.length - suffix;
  if (split <= 0) return built;
  stripBreakpoints(messages, split);
  if (!placeBreakpoint(messages, split)) return built;
  return { ...built, body: JSON.stringify(body) };
}

function withMovedBreakpoint(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    buildRequest: (turns, model, options) =>
      moveBreakpointToPersistedTail(
        adapter.buildRequest(turns, model, options),
        options,
      ),
  };
}

export function withAnthropicCacheBreakpoint(
  adapters: AdapterRegistry,
): AdapterRegistry {
  return {
    has: (provider) => adapters.has(provider),
    resolve(source, quirks) {
      const adapter = adapters.resolve(source, quirks);
      if (!ANTHROPIC_MESSAGES_PROVIDERS.has(source.provider)) return adapter;
      return withMovedBreakpoint(adapter);
    },
  };
}
