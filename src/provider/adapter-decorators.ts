/**
 * Shared adapter decorator mechanics. Only the JSON-body / extra-header /
 * registry plumbing is shared; the per-adapter semantics stay in each
 * adapter's rewrite or header factory (codex parallel_tool_calls, DeepSeek
 * reasoning strip and V4 quirks, Bifrost virtual-key sentinel, anthropic
 * session header). Every decorator is a null overhead: when its hook bails,
 * the base request's body and headers pass through byte-identical.
 */

import type {
  AdapterRegistry,
  BuiltRequest,
  ProviderAdapter,
} from "@intx/inference";
import type {
  ConversationTurn,
  InferenceOptions,
  LastCycleSource,
} from "@intx/types/runtime";

export type DecoratorContext = {
  readonly messages: readonly ConversationTurn[];
  readonly model: string;
  readonly options: InferenceOptions;
};

/** Parse the built body, apply the rewrite, and re-stringify only when the
 * rewrite reports a change. An optional gate keeps adapters that only
 * sometimes rewrite on their zero-parse fast path. */
export function withJsonBodyRewrite(
  adapter: ProviderAdapter,
  rewrite: (
    body: Record<string, unknown>,
    context: DecoratorContext,
  ) => boolean,
  gate?: (request: BuiltRequest, context: DecoratorContext) => boolean,
): ProviderAdapter {
  return {
    ...adapter,
    buildRequest: (messages, model, options) => {
      const built = adapter.buildRequest(messages, model, options);
      const context: DecoratorContext = { messages, model, options };
      if (gate !== undefined && !gate(built, context)) return built;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(built.body) as Record<string, unknown>;
      } catch {
        return built;
      }
      if (!rewrite(body, context)) return built;
      return { ...built, body: JSON.stringify(body) };
    },
  };
}

/** Merge the factory's headers over the built request's own; the spread
 * never removes or rewrites a header the base adapter emitted. */
export function withExtraHeaders(
  adapter: ProviderAdapter,
  headers: (context: DecoratorContext) => Record<string, string>,
): ProviderAdapter {
  return {
    ...adapter,
    buildRequest: (messages, model, options) => {
      const built = adapter.buildRequest(messages, model, options);
      const context: DecoratorContext = { messages, model, options };
      return {
        ...built,
        headers: { ...built.headers, ...headers(context) },
      };
    },
  };
}

/** Wrap an adapter registry so every resolved adapter passes through the
 * decorator; membership is delegated untouched. */
export function withDecoratedAdapters(
  adapters: AdapterRegistry,
  decorate: (
    adapter: ProviderAdapter,
    source: LastCycleSource,
  ) => ProviderAdapter,
): AdapterRegistry {
  return {
    has: (provider) => adapters.has(provider),
    resolve(source, quirks) {
      return decorate(adapters.resolve(source, quirks), source);
    },
  };
}
