// Emits PostHog AI observability events ($ai_generation, optionally $ai_span)
// from a completed turn, in the same privacy mode as product telemetry: only
// ids, enums, and counts ever leave the process. TurnContext already carries
// tool call arguments and results for lifecycle hooks — this module reads only
// the scalar/id fields off it and never the content fields.
//
// Default volume shape (CL-6816): one $ai_generation per turn with tool/subagent
// aggregates folded onto it. Per-call $ai_span events are opt-in via
// CORBITS_TELEMETRY_AI_SPANS for debugging.

import type { TurnContext } from "../session/hooks.js";
import { isSubagentToolName } from "../subagent/tool-taxonomy.js";
import {
  noteLastTurnTraceId,
  noteCurrentTurnTraceId,
  clearCurrentTurnTraceId,
} from "./feedback.js";

import {
  aiSpansEnabled,
  generationSampleRate,
  type AiErrorKind,
  type AiSpanKind,
  type Telemetry,
} from "./index.js";

// PostHog reports latency in seconds as a float; the runtime measures every
// duration in milliseconds. Reporting milliseconds under the seconds-typed
// property inflates every latency by 1000x and still renders plausibly.
const MS_PER_SECOND = 1000;

export function secondsFromMs(durationMs: number): number {
  return durationMs / MS_PER_SECOND;
}

// Scoped to the runtime's per-session id rather than the process-wide
// telemetry session id: sub-agents run in this same process, so a
// process-wide scope would give a parent's turn 3 and a sub-agent's turn 3
// the same trace id and silently merge two unrelated traces.
export function turnTraceId(sessionId: string, turnIndex: number): string {
  return `${sessionId}:turn:${turnIndex}`;
}

// Maps a tool call to a fixed span kind. Takes the tool's canonical name
// rather than reaching into subagent internals, so this module has no dependency on tool
// implementations beyond the one identifier it needs to classify.
export function classifySpanKind(toolName: string): AiSpanKind {
  return isSubagentToolName(toolName) ? "subagent_call" : "tool_call";
}

// Word-bounded so a status code is only read where one was actually written.
// A bare substring match reads "used 1401 tokens" as an auth rejection and
// "retry after 4290ms" as a rate limit, which is a misclassification that
// looks entirely plausible in a dashboard.
const RATE_LIMIT_STATUS = /\b429\b/;
const AUTH_STATUS = /\b(?:401|403)\b/;

// Reduces a provider error to a fixed reason. The message itself is never
// sent: it routinely embeds the request URL, the offending prompt, or a
// local file path.
export function classifyErrorKind(message: string): AiErrorKind {
  const text = message.toLowerCase();
  if (text.includes("rate limit") || RATE_LIMIT_STATUS.test(text)) return "rate_limit";
  if (text.includes("unauthorized") || AUTH_STATUS.test(text)) return "auth";
  // Ahead of the timeout check: the runtime aborts the in-flight call when a
  // total timeout fires, so its message names both, and what the user did —
  // or had done to their turn — is the more useful of the two readings.
  if (text.includes("abort") || text.includes("cancel")) return "cancelled";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  return "inference_failed";
}

export interface EmitAiObservabilityOptions {
  // The runtime's per-session id, which scopes the trace id.
  sessionId: string;
  /** Override process.env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override Math.random for generation sampling tests. */
  random?: () => number;
}

export interface ToolCallAggregates {
  tool_call_count: number;
  tool_error_count: number;
  subagent_call_count: number;
}

export function aggregateToolCalls(
  ctx: Pick<TurnContext, "toolCalls" | "toolResults">,
): ToolCallAggregates {
  const resultsByCallId = new Map(ctx.toolResults.map((result) => [result.callId, result]));
  let tool_call_count = 0;
  let tool_error_count = 0;
  let subagent_call_count = 0;
  for (const call of ctx.toolCalls) {
    const kind = classifySpanKind(call.name);
    if (kind === "subagent_call") {
      subagent_call_count += 1;
    } else {
      tool_call_count += 1;
    }
    if (resultsByCallId.get(call.id)?.isError === true) {
      tool_error_count += 1;
    }
  }
  return { tool_call_count, tool_error_count, subagent_call_count };
}

function shouldSampleSuccessfulGeneration(env: NodeJS.ProcessEnv, random: () => number): boolean {
  const rate = generationSampleRate(env);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return random() < rate;
}

// Called once per completed turn. Emits one $ai_generation for the model
// call with tool/subagent aggregates. Per-call $ai_span events are emitted
// only when CORBITS_TELEMETRY_AI_SPANS is truthy. The trace is flat by
// construction: every span's $ai_parent_id is the trace id. PostHog
// synthesises the trace itself from these children, so no $ai_trace event is
// emitted.
export function emitAiObservability(
  telemetry: Telemetry,
  ctx: TurnContext,
  options: EmitAiObservabilityOptions,
): void {
  const env = options.env ?? process.env;
  const random = options.random ?? Math.random;
  const traceId = turnTraceId(options.sessionId, ctx.turnIndex);
  // Remember for intentional /feedback linking (works even when ambient capture
  // is a no-op because this call still computes the id).
  noteLastTurnTraceId(traceId);

  if (!shouldSampleSuccessfulGeneration(env, random)) {
    // Sampling drops the whole turn package, including opt-in `$ai_span`s —
    // a span without its parent generation is not useful in PostHog traces.
    return;
  }

  const aggregates = aggregateToolCalls(ctx);

  telemetry.capture("$ai_generation", {
    $ai_trace_id: traceId,
    // The canonical provider kind, never ctx.source.sourceId: sourceId is the
    // user-typed label from onboarding/settings, and free text must not leave
    // the process under the no-PII contract.
    $ai_provider: ctx.source.provider,
    $ai_model: ctx.source.model,
    $ai_input_tokens: ctx.usage.input,
    $ai_output_tokens: ctx.usage.output,
    $ai_latency: secondsFromMs(ctx.durationMs),
    $ai_is_error: false,
    $ai_cache_read_input_tokens: ctx.usage.cacheRead,
    $ai_cache_creation_input_tokens: ctx.usage.cacheWrite,
    $ai_reasoning_tokens: ctx.usage.thinking,
    tool_call_count: aggregates.tool_call_count,
    tool_error_count: aggregates.tool_error_count,
    subagent_call_count: aggregates.subagent_call_count,
  });

  if (!aiSpansEnabled(env)) return;

  const resultsByCallId = new Map(ctx.toolResults.map((result) => [result.callId, result]));

  for (const call of ctx.toolCalls) {
    const result = resultsByCallId.get(call.id);
    telemetry.capture("$ai_span", {
      $ai_trace_id: traceId,
      // The provider's own opaque call id, which is what makes it safe to
      // send: it identifies the call within the trace and nothing else.
      $ai_span_id: call.id,
      $ai_parent_id: traceId,
      $ai_span_name: classifySpanKind(call.name),
      $ai_is_error: result?.isError === true,
    });
  }
}

// The canonical provider kind and model id a turn ran against. Never the
// sourceId: that is the free-text label the user typed in onboarding or
// settings.
export interface TurnSource {
  provider: string;
  model: string;
}

export interface EmitAiTurnFailureOptions {
  sessionId: string;
  turnIndex: number;
  // The failed turn has no TurnContext to read its source from, so the caller
  // supplies it. Without these two the first question failure data is ever
  // asked — which model is rate-limiting us — has no answer at all.
  source: TurnSource;
  // The raw provider message, classified here and never forwarded.
  error: string;
}

// Called when a turn ends without ever completing, which is where
// observability earns its keep and where a completion-only emitter is
// silent. Emits the $ai_generation the turn never got to emit, marked as an
// error, with no token counts or latency because the turn produced none.
// Errored generations always ship (no sampling).
export function emitAiTurnFailure(telemetry: Telemetry, options: EmitAiTurnFailureOptions): void {
  telemetry.capture("$ai_generation", {
    $ai_trace_id: turnTraceId(options.sessionId, options.turnIndex),
    $ai_provider: options.source.provider,
    $ai_model: options.source.model,
    $ai_is_error: true,
    $ai_error: classifyErrorKind(options.error),
  });
}

export interface CreateTurnObserverOptions {
  // Read per emission because the TUI replaces the telemetry handle when the
  // user toggles the setting mid-session.
  telemetry: () => Telemetry;
  // Also read per emission: starting a new session reassigns the runtime
  // session id in this same process, and a trace id built from a captured
  // one would file the new session's turns under the old session's traces.
  getSessionId: () => string;
  // The currently selected source. It is safe failure attribution only when
  // its model matches the model named by the latest inference.start.
  getSource: () => TurnSource;
}

const UNKNOWN_INFERENCE_PROVIDER = "unknown";

function failedAttemptSource(
  attemptedModel: string | undefined,
  observedSource: TurnSource | undefined,
  selectedSource: TurnSource,
): TurnSource {
  if (observedSource !== undefined) return observedSource;
  if (attemptedModel === undefined || attemptedModel === selectedSource.model) {
    return selectedSource;
  }
  return { provider: UNKNOWN_INFERENCE_PROVIDER, model: attemptedModel };
}

// Binds the emitters to the live session and source, keeping the "read it now,
// do not capture it" rule in one place instead of at each call site.
export function createTurnObserver(options: CreateTurnObserverOptions): {
  onTurnStarted: (info: { turnIndex: number; model: string }) => void;
  onTurnSourceObserved: (info: { turnIndex: number; source: TurnSource }) => void;
  onTurnComplete: (ctx: TurnContext) => void;
  onTurnFailed: (info: { turnIndex: number; error: string }) => void;
} {
  let latestAttemptModel: string | undefined;
  let latestAttemptSource: TurnSource | undefined;

  function clearAttempt(): void {
    latestAttemptModel = undefined;
    latestAttemptSource = undefined;
  }

  return {
    onTurnStarted: (info) => {
      latestAttemptModel = info.model;
      latestAttemptSource = undefined;
      noteCurrentTurnTraceId(turnTraceId(options.getSessionId(), info.turnIndex));
    },
    onTurnSourceObserved: (info) => {
      latestAttemptSource = { ...info.source };
    },
    onTurnComplete: (ctx) => {
      clearAttempt();
      clearCurrentTurnTraceId();
      emitAiObservability(options.telemetry(), ctx, {
        sessionId: options.getSessionId(),
      });
    },
    onTurnFailed: (info) => {
      clearCurrentTurnTraceId();
      const source = failedAttemptSource(
        latestAttemptModel,
        latestAttemptSource,
        options.getSource(),
      );
      clearAttempt();
      emitAiTurnFailure(options.telemetry(), {
        sessionId: options.getSessionId(),
        source,
        ...info,
      });
    },
  };
}
