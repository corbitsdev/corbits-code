import type {
  AdapterRegistry,
  ExtendedInferenceOptions,
  ProviderAdapter,
} from "@intx/inference";
import {
  withDecoratedAdapters,
  withJsonBodyRewrite,
} from "./adapter-decorators.js";
import { ANTHROPIC_MESSAGES_PROTOCOLS } from "./provider-protocols.js";

type WireBlock = Record<string, unknown>;

type WireMessage = {
  role?: unknown;
  content?: unknown;
};

function ephemeralSuffixLength(options: ExtendedInferenceOptions): number {
  const turns = options.ephemeralTurns;
  if (turns === undefined) return 0;
  return turns.filter((turn) => turn.role !== "system").length;
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
  body: Record<string, unknown>,
  options: ExtendedInferenceOptions,
): boolean {
  const suffix = ephemeralSuffixLength(options);
  if (suffix === 0) return false;
  if (!Array.isArray(body.messages)) return false;
  const messages = body.messages as WireMessage[];
  const split = messages.length - suffix;
  if (split <= 0) return false;
  stripBreakpoints(messages, split);
  return placeBreakpoint(messages, split);
}

// Only Anthropic-protocol sources are decorated, so non-Anthropic requests
// skip both the gate and the body parse (byte-identical to the base adapter).
function withMovedBreakpoint(adapter: ProviderAdapter): ProviderAdapter {
  return withJsonBodyRewrite(
    adapter,
    (body, { options }) => moveBreakpointToPersistedTail(body, options),
    (_request, { options }) => ephemeralSuffixLength(options) > 0,
  );
}

export function withAnthropicCacheBreakpoint(
  adapters: AdapterRegistry,
): AdapterRegistry {
  return withDecoratedAdapters(adapters, (adapter, source) =>
    ANTHROPIC_MESSAGES_PROTOCOLS.has(source.provider)
      ? withMovedBreakpoint(adapter)
      : adapter,
  );
}
