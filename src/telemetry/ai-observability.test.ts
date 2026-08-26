import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { afterEach, describe, expect, test } from "bun:test";
import type { Telemetry } from "./index.js";
import { generationSampleRate } from "./index.js";
import type { TurnContext } from "../session/hooks.js";
import {
  aggregateToolCalls,
  classifyErrorKind,
  classifySpanKind,
  createTurnObserver,
  emitAiObservability,
  emitAiTurnFailure,
  secondsFromMs,
  turnTraceId,
} from "./ai-observability.js";
import { getCurrentTurnTraceId, resetFeedbackStateForTests } from "./feedback.js";

const SUBAGENT_TOOL_NAME = "task";
const SESSION_ID = "0199-parent-session";

afterEach(() => {
  resetFeedbackStateForTests();
});

function fakeTelemetry(): {
  telemetry: Telemetry;
  captured: { event: string; properties: Record<string, unknown> }[];
} {
  const captured: { event: string; properties: Record<string, unknown> }[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    installationId: "test-install",
    capture: (event, properties = {}) => {
      captured.push({ event, properties });
    },
    captureIntentional: () => false,
    flush: async () => {},
    discard: () => {},
  };
  return { telemetry, captured };
}

function fakeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  const toolCalls: ToolCall[] = [
    {
      id: "call-1",
      name: "read_file",
      arguments: { path: "/Users/attacker/secret-project/plan.md" },
    },
    {
      id: "call-2",
      name: SUBAGENT_TOOL_NAME,
      arguments: {
        description: "explore",
        prompt: "find the leaked API key XYZ-SECRET-123",
        intent: "explore",
      },
    },
  ];
  const toolResults: ToolResult[] = [
    { callId: "call-1", content: "file contents: super secret prompt text" },
    {
      callId: "call-2",
      content: "sub-agent report containing prompt XYZ-SECRET-123",
      isError: true,
    },
  ];
  return {
    turnIndex: 3,
    assistantTurn: {
      role: "assistant",
      content: [{ type: "text", text: "here is the plan: XYZ-SECRET-123" }],
      model: "model-x",
      timestamp: 0,
    },
    toolCalls,
    toolResults,
    usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, thinking: 3 },
    source: { provider: "openai-compatible", model: "model-x" },
    durationMs: 4560,
    ...overrides,
  } as TurnContext;
}

const emitOptions = { sessionId: SESSION_ID, env: {} };
const FAILED_TURN_SOURCE = { provider: "openai-compatible", model: "model-x" };

describe("secondsFromMs", () => {
  test("converts milliseconds to fractional seconds, the unit PostHog documents", () => {
    expect(secondsFromMs(361)).toBe(0.361);
    expect(secondsFromMs(4560)).toBe(4.56);
    expect(secondsFromMs(0)).toBe(0);
  });
});

describe("classifySpanKind", () => {
  test("classifies both subagent dispatch tools as subagent_call", () => {
    expect(classifySpanKind("task")).toBe("subagent_call");
    expect(classifySpanKind("spawn_agent")).toBe("subagent_call");
  });

  test("classifies every other tool as tool_call, regardless of name", () => {
    expect(classifySpanKind("read_file")).toBe("tool_call");
    expect(classifySpanKind("mcp__acme__fetch_secret")).toBe("tool_call");
  });
});

describe("classifyErrorKind", () => {
  test("reduces provider messages to fixed reasons", () => {
    expect(classifyErrorKind("HTTP 429 rate limit exceeded")).toBe("rate_limit");
    expect(classifyErrorKind("401 Unauthorized")).toBe("auth");
    expect(classifyErrorKind("request timed out after 60s")).toBe("timeout");
    expect(classifyErrorKind("The operation was aborted")).toBe("cancelled");
    expect(classifyErrorKind("upstream returned garbage")).toBe("inference_failed");
  });

  // The message the runtime itself produces when the user stops a turn.
  // docs/TELEMETRY.md states a stopped turn is reported as `cancelled`, and
  // the enum member exists only because this path can produce it.
  test("classifies the runtime's own abort message as cancelled", () => {
    expect(classifyErrorKind("inference aborted")).toBe("cancelled");
  });

  test("reads a status code only where one was written, not any matching digits", () => {
    expect(classifyErrorKind("the model used 1401 tokens and stopped")).toBe("inference_failed");
    expect(classifyErrorKind("retry after 4290 ms")).toBe("inference_failed");
    expect(classifyErrorKind("HTTP 403 forbidden")).toBe("auth");
  });

  test("reports an abort that followed a timeout as cancelled, not timeout", () => {
    expect(classifyErrorKind("request aborted after timeout")).toBe("cancelled");
  });

  test("still reports a timeout that was never aborted as timeout", () => {
    expect(classifyErrorKind("inference call exceeded inactivity timeout (60000 ms)")).toBe(
      "timeout",
    );
  });
});

describe("turnTraceId", () => {
  test("derives from the runtime session id and turn index rather than inventing a random id", () => {
    expect(turnTraceId("session-abc", 3)).toBe("session-abc:turn:3");
    expect(turnTraceId("session-abc", 3)).toBe(turnTraceId("session-abc", 3));
  });
});

describe("representative fleet event volume", () => {
  test("reduces deterministic synthetic billable events by at least 80 percent", () => {
    const captureFixture = (includeToolSpans: boolean): string[] => {
      const captured: string[] = [];
      for (let turn = 0; turn < 10; turn++) captured.push("$ai_generation");
      if (includeToolSpans) {
        for (let toolCall = 0; toolCall < 80; toolCall++) captured.push("$ai_span");
      }
      for (let worker = 0; worker < 4; worker++) {
        captured.push("subagent_start", "subagent_end");
      }
      return captured;
    };

    const oldCaptured = captureFixture(true);
    const newCaptured = captureFixture(false);
    const reduction = 1 - newCaptured.length / oldCaptured.length;

    expect(oldCaptured).toHaveLength(98);
    expect(newCaptured).toHaveLength(18);
    expect(oldCaptured.length - newCaptured.length).toBe(80);
    expect(reduction).toBeCloseTo(80 / 98, 6);
    expect(reduction).toBeGreaterThanOrEqual(0.8);
  });
});

describe("aggregateToolCalls", () => {
  test("counts tool calls, subagent calls, and errors separately", () => {
    expect(aggregateToolCalls(fakeTurnContext())).toEqual({
      tool_call_count: 1,
      tool_error_count: 1,
      subagent_call_count: 1,
    });
  });
});

describe("createTurnObserver", () => {
  // Regression: the trace id must be built from whatever session id is live
  // at emission. A call site that captured it once would keep filing turns
  // under the session the process started in, which is the bug asserting two
  // different strings produce two different ids can never catch.
  test("re-reads the session id per turn, so a new session starts a new trace", () => {
    const { telemetry, captured } = fakeTelemetry();
    let sessionId = "session-one";
    const observer = createTurnObserver({
      telemetry: () => telemetry,
      getSessionId: () => sessionId,
      getSource: () => ({ provider: "openai-compatible", model: "model-x" }),
    });

    observer.onTurnComplete(fakeTurnContext({ turnIndex: 0, toolCalls: [], toolResults: [] }));
    sessionId = "session-two";
    observer.onTurnComplete(fakeTurnContext({ turnIndex: 0, toolCalls: [], toolResults: [] }));

    const traceIds = captured.map((c) => c.properties.$ai_trace_id);
    expect(traceIds).toEqual(["session-one:turn:0", "session-two:turn:0"]);
  });

  test("re-reads the session id for a failed turn too", () => {
    const { telemetry, captured } = fakeTelemetry();
    let sessionId = "session-one";
    const observer = createTurnObserver({
      telemetry: () => telemetry,
      getSessionId: () => sessionId,
      getSource: () => ({ provider: "openai-compatible", model: "model-x" }),
    });

    observer.onTurnFailed({ turnIndex: 0, error: "boom" });
    sessionId = "session-two";
    observer.onTurnFailed({ turnIndex: 0, error: "boom" });

    expect(captured.map((c) => c.properties.$ai_trace_id)).toEqual([
      "session-one:turn:0",
      "session-two:turn:0",
    ]);
  });

  test("attributes a failed turn to the source live at the moment it failed", () => {
    const { telemetry, captured } = fakeTelemetry();
    let source = { provider: "openai-compatible", model: "model-x" };
    const observer = createTurnObserver({
      telemetry: () => telemetry,
      getSessionId: () => SESSION_ID,
      getSource: () => source,
    });

    observer.onTurnFailed({ turnIndex: 0, error: "429 rate limit" });
    source = { provider: "codex", model: "model-y" };
    observer.onTurnFailed({ turnIndex: 1, error: "429 rate limit" });

    expect(captured[0]?.properties.$ai_provider).toBe("openai-compatible");
    expect(captured[0]?.properties.$ai_model).toBe("model-x");
    expect(captured[1]?.properties.$ai_provider).toBe("codex");
    expect(captured[1]?.properties.$ai_model).toBe("model-y");
  });

  test("onTurnStarted notes the in-flight turn for subagent parent_trace_id", () => {
    const { telemetry } = fakeTelemetry();
    const observer = createTurnObserver({
      telemetry: () => telemetry,
      getSessionId: () => SESSION_ID,
      getSource: () => ({ provider: "openai-compatible", model: "model-x" }),
    });

    observer.onTurnStarted({ turnIndex: 2 });
    expect(getCurrentTurnTraceId()).toBe(`${SESSION_ID}:turn:2`);
    observer.onTurnComplete(fakeTurnContext({ turnIndex: 2, toolCalls: [], toolResults: [] }));
    expect(getCurrentTurnTraceId()).toBeUndefined();
  });
});

describe("emitAiObservability", () => {
  test("emits one $ai_generation with aggregates and zero $ai_span by default", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), emitOptions);

    expect(captured.length).toBe(1);
    expect(captured[0]?.event).toBe("$ai_generation");
    expect(captured[0]?.properties.tool_call_count).toBe(1);
    expect(captured[0]?.properties.tool_error_count).toBe(1);
    expect(captured[0]?.properties.subagent_call_count).toBe(1);
    expect(captured.filter((c) => c.event === "$ai_span")).toHaveLength(0);
  });

  test("restores per-call $ai_span when CORBITS_TELEMETRY_AI_SPANS is truthy", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_AI_SPANS: "1" },
    });

    expect(captured.length).toBe(3);
    expect(captured[0]?.event).toBe("$ai_generation");
    expect(captured[1]?.event).toBe("$ai_span");
    expect(captured[2]?.event).toBe("$ai_span");
  });

  test("reports latency in seconds, not milliseconds", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext({ durationMs: 361 }), emitOptions);

    const generation = captured.find((c) => c.event === "$ai_generation");
    expect(generation?.properties.$ai_latency).toBe(0.361);
    expect(generation?.properties.$ai_latency).not.toBe(361);
  });

  test("names every field PostHog's LLM analytics views actually query", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), emitOptions);

    const generation = captured.find((c) => c.event === "$ai_generation");
    expect(generation?.properties.$ai_provider).toBe("openai-compatible");
    expect(generation?.properties.$ai_model).toBe("model-x");
    expect(generation?.properties.$ai_input_tokens).toBe(10);
    expect(generation?.properties.$ai_output_tokens).toBe(20);
    expect(generation?.properties).not.toHaveProperty("provider_id");
    expect(generation?.properties).not.toHaveProperty("input_tokens");
    expect(generation?.properties).not.toHaveProperty("duration_ms");
  });

  // CL-5749: PostHog cost views read only $ai_*-prefixed cache/reasoning
  // properties. Unprefixed names land as custom fields and skew spend.
  // Source: https://posthog.com/docs/ai-observability/installation/manual-capture
  // and PostHog cost-properties reference ($ai_cache_read_input_tokens,
  // $ai_cache_creation_input_tokens, $ai_reasoning_tokens).
  test("names cache and reasoning token properties for PostHog cost views", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), emitOptions);

    const generation = captured.find((c) => c.event === "$ai_generation");
    expect(generation?.properties.$ai_cache_read_input_tokens).toBe(1);
    expect(generation?.properties.$ai_cache_creation_input_tokens).toBe(2);
    expect(generation?.properties.$ai_reasoning_tokens).toBe(3);
    expect(generation?.properties).not.toHaveProperty("cache_read_tokens");
    expect(generation?.properties).not.toHaveProperty("cache_write_tokens");
    expect(generation?.properties).not.toHaveProperty("thinking_tokens");
  });

  test("flat trace: spans parent onto the trace id, not onto each other", () => {
    const { telemetry, captured } = fakeTelemetry();
    const ctx = fakeTurnContext();

    emitAiObservability(telemetry, ctx, {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_AI_SPANS: "1" },
    });

    const traceId = turnTraceId(SESSION_ID, ctx.turnIndex);
    const generation = captured.find((c) => c.event === "$ai_generation");
    const spans = captured.filter((c) => c.event === "$ai_span");

    expect(generation?.properties.$ai_trace_id).toBe(traceId);
    for (const span of spans) {
      expect(span.properties.$ai_trace_id).toBe(traceId);
      expect(span.properties.$ai_parent_id).toBe(traceId);
    }
    expect(spans[0]?.properties.$ai_span_id).toBe("call-1");
    expect(spans[1]?.properties.$ai_span_id).toBe("call-2");
  });

  test("names the span by fixed enum, never the raw tool name", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_AI_SPANS: "true" },
    });

    const spans = captured.filter((c) => c.event === "$ai_span");
    expect(spans[0]?.properties.$ai_span_name).toBe("tool_call");
    expect(spans[1]?.properties.$ai_span_name).toBe("subagent_call");
    for (const span of spans) {
      expect(span.properties.$ai_span_name).not.toBe("read_file");
      expect(span.properties.$ai_span_name).not.toBe(SUBAGENT_TOOL_NAME);
    }
  });

  test("propagates tool error state onto the span without the result content", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_AI_SPANS: "1" },
    });

    const spans = captured.filter((c) => c.event === "$ai_span");
    expect(spans[0]?.properties.$ai_is_error).toBe(false);
    expect(spans[1]?.properties.$ai_is_error).toBe(true);
  });

  test("never leaks prompt text, tool arguments, tool results, or file paths", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_AI_SPANS: "1" },
    });

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("plan.md");
    expect(serialized).not.toContain("XYZ-SECRET-123");
    expect(serialized).not.toContain("super secret prompt text");
    expect(serialized).not.toContain("find the leaked");
    expect(serialized).not.toContain("here is the plan");
    expect(serialized).not.toContain("/Users/attacker");
  });

  test("samples successful generations when CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE is below 1", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE: "0.5" },
      random: () => 0.9,
    });

    expect(captured).toHaveLength(0);
  });

  test("always keeps a successful generation when the sample roll is under the rate", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiObservability(telemetry, fakeTurnContext(), {
      ...emitOptions,
      env: { CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE: "0.5" },
      random: () => 0.1,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("$ai_generation");
  });

  test("empty CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE is treated as unset (1.0)", () => {
    expect(generationSampleRate({ CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE: "" })).toBe(1);
    expect(generationSampleRate({ CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE: "  " })).toBe(1);
    expect(generationSampleRate({})).toBe(1);
    expect(generationSampleRate({ CORBITS_TELEMETRY_GENERATION_SAMPLE_RATE: "0" })).toBe(0);
  });
});

describe("emitAiTurnFailure", () => {
  test("emits an errored $ai_generation for a turn that never completed", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiTurnFailure(telemetry, {
      sessionId: SESSION_ID,
      turnIndex: 7,
      source: FAILED_TURN_SOURCE,
      error: "HTTP 429 rate limit exceeded",
    });

    expect(captured.length).toBe(1);
    expect(captured[0]?.event).toBe("$ai_generation");
    expect(captured[0]?.properties.$ai_trace_id).toBe(turnTraceId(SESSION_ID, 7));
    expect(captured[0]?.properties.$ai_is_error).toBe(true);
    expect(captured[0]?.properties.$ai_error).toBe("rate_limit");
  });

  // Which model is failing is the first question failure data is asked, and
  // a generation with no provider or model cannot answer it.
  test("attributes the failure to a provider and model", () => {
    const { telemetry, captured } = fakeTelemetry();

    emitAiTurnFailure(telemetry, {
      sessionId: SESSION_ID,
      turnIndex: 7,
      source: FAILED_TURN_SOURCE,
      error: "HTTP 429 rate limit exceeded",
    });

    expect(captured[0]?.properties.$ai_provider).toBe("openai-compatible");
    expect(captured[0]?.properties.$ai_model).toBe("model-x");
  });

  test("errored generations always ship regardless of sample rate", () => {
    const { telemetry, captured } = fakeTelemetry();

    // emitAiTurnFailure has no sample gate — confirm directly.
    emitAiTurnFailure(telemetry, {
      sessionId: SESSION_ID,
      turnIndex: 1,
      source: FAILED_TURN_SOURCE,
      error: "boom",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties.$ai_is_error).toBe(true);
  });

  test("never forwards the provider's error message", () => {
    const { telemetry, captured } = fakeTelemetry();
    const message =
      "POST https://api.acme.internal/v1/chat failed: prompt contained /Users/attacker/secret.md";

    emitAiTurnFailure(telemetry, {
      sessionId: SESSION_ID,
      turnIndex: 7,
      source: FAILED_TURN_SOURCE,
      error: message,
    });

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("acme.internal");
    expect(serialized).not.toContain("/Users/attacker");
    expect(serialized).not.toContain(message);
  });
});
