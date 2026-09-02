/**
 * Pure production stream/reactor → BridgeInboundEvent mapping.
 *
 * Covers the event types a normal turn paints (user, assistant deltas, tools,
 * attempt boundaries). No renderer / OpenTUI deps — unit-testable.
 */

import {
  splitPendingControlTail,
  stripTerminalControlSequences,
} from "../util/control-char-strip.js";
import { terminalProviderFailureMessage } from "../inference-error-message.js";
import type { InferenceErrorLike } from "../inference-gateway-error.js";
import type { RunState } from "./session-queue.js";

/** Canonical inbound events the bridge understands (fixtures + mapped reactor). */
export type BridgeInboundEvent =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "assistant.delta"; readonly text: string }
  | { readonly type: "thinking.delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly name: string;
      readonly detail?: string;
      /** Runtime call id, when the source event carried one. */
      readonly callId?: string;
    }
  | {
      readonly type: "tool_result";
      readonly name: string;
      readonly detail?: string;
      readonly isError?: boolean;
      /** Call this result answers — how a result finds the row it resolves. */
      readonly callId?: string;
    }
  | { readonly type: "system"; readonly text: string }
  | { readonly type: "run"; readonly state: RunState }
  /**
   * Live fleet-lane count. Emitted by the runner on every transition of
   * the sub-agent store's running-lane count; drives idle-with-fleet —
   * the run stays busy after the parent turn settles until this lands
   * back at zero (true session-idle), and Enter mid-hold upgrades to a
   * new turn rather than a queued steer.
   */
  | { readonly type: "fleet"; readonly running: number }
  | { readonly type: "tool.boundary" }
  | { readonly type: "error"; readonly message: string }
  /**
   * Attempt-boundary bookkeeping for retries. `mark` records where the current
   * inference attempt's rows begin, `clear` disarms that boundary once the
   * attempt has settled, and `rollback` retracts everything painted since it.
   * The mapper decides *when*; the consumer owns the row index.
   */
  | {
      readonly type: "attempt";
      readonly action: "mark" | "clear" | "rollback";
    };

/** Loose reactor-shaped event (no hard dep on @intx/inference). */
export interface ReactorLikeEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly seq?: number;
}

/**
 * Reactor / stream types that are not bridge-native and must go through the
 * production mapper (avoids collisions like tool.done vs bridge tool_result).
 */
export const PRODUCTION_REACTOR_TYPES: ReadonlySet<string> = new Set([
  "message.received",
  "inference.start",
  "inference.done",
  "inference.retry",
  "inference.text.delta",
  "inference.thinking.delta",
  "inference.tool_call.start",
  "inference.tool_call.delta",
  "inference.tool_call.end",
  "tool.start",
  "tool.done",
  "connector.reply",
  "reactor.done",
  "reactor.error",
  "inference.error",
]);

/** Optional session bookkeeping so tool.done can resolve the name of its call. */
export interface StreamMapContext {
  readonly callIdToName: Map<string, string>;
  readonly callIdToArgs: Map<string, string>;
  /** callIds that already painted a tool_call row (avoid start/end doubles). */
  readonly emittedToolCalls: Set<string>;
  /** True after text deltas in the current assistant burst (skip connector.reply paint). */
  hadTextDelta: boolean;
  /** Trailing fragment of a possibly-incomplete escape sequence, per channel. */
  readonly pendingDelta: { assistant: string; thinking: string };
  /**
   * True between an `inference.start` and the event that settles its cycle.
   * `inference.retry` has two producers with opposite meanings, told apart by
   * ordering: the harness emits it for a pre-commit retry, before the cycle's
   * `inference.start`, when the failed attempt streamed nothing and there is
   * nothing to retract. The reactor emits it after a committed attempt failed
   * and is about to re-stream what it already painted. Only a retry arriving
   * while this is armed retracts.
   */
  attemptArmed: boolean;
  /** Tool calls already known when the current attempt started. */
  attemptCallIds: Set<string>;
  /**
   * A committed attempt can also end in `inference.error` with no
   * `inference.done`. A same-provider retry follows that error with another
   * `inference.start`. The boundary must not stay armed across a terminal
   * error, so the error hands it off here: the very next event consumes it and
   * retracts the failed attempt, or expires it and keeps the error row.
   */
  errorRollbackArmed: boolean;
  /**
   * Live catalog provider id (e.g. `xai/thegreataxios`). Harness
   * `inference.error` events omit providerId; the session stamps this so
   * transcript formatting can reuse known-provider remappers.
   */
  providerId?: string;
  providerLabel?: string;
  /** Classified diagnostics are held only for render-time terminal presentation. */
  pendingProviderFailure: boolean;
  pendingProviderError: InferenceErrorLike | undefined;
}

export function createStreamMapContext(opts?: {
  providerId?: string;
  providerLabel?: string;
}): StreamMapContext {
  return {
    callIdToName: new Map(),
    callIdToArgs: new Map(),
    emittedToolCalls: new Set(),
    hadTextDelta: false,
    pendingDelta: { assistant: "", thinking: "" },
    attemptArmed: false,
    attemptCallIds: new Set(),
    errorRollbackArmed: false,
    pendingProviderFailure: false,
    pendingProviderError: undefined,
    ...(opts?.providerId !== undefined ? { providerId: opts.providerId } : {}),
    ...(opts?.providerLabel !== undefined ? { providerLabel: opts.providerLabel } : {}),
  };
}

const ATTEMPT_MARK: BridgeInboundEvent = { type: "attempt", action: "mark" };
const ATTEMPT_CLEAR: BridgeInboundEvent = { type: "attempt", action: "clear" };
const ATTEMPT_ROLLBACK: BridgeInboundEvent = {
  type: "attempt",
  action: "rollback",
};

/** Disarm the attempt boundary, emitting the consumer-visible clear if it was armed. */
function disarmAttempt(ctx: StreamMapContext | undefined): readonly BridgeInboundEvent[] {
  if (!ctx || !ctx.attemptArmed) return [];
  ctx.attemptArmed = false;
  return [ATTEMPT_CLEAR];
}

/** Drop call bookkeeping and held deltas that belonged only to the failed attempt. */
function forgetAttemptLocalState(ctx: StreamMapContext): void {
  for (const callId of [...ctx.callIdToName.keys()]) {
    if (ctx.attemptCallIds.has(callId)) continue;
    ctx.callIdToName.delete(callId);
    ctx.callIdToArgs.delete(callId);
    ctx.emittedToolCalls.delete(callId);
  }
  ctx.hadTextDelta = false;
  ctx.pendingDelta.assistant = "";
  ctx.pendingDelta.thinking = "";
}

function recoversErrorHandoff(type: string): boolean {
  return type === "inference.retry" || type === "inference.start";
}

type DeltaChannel = "assistant" | "thinking";

const DELTA_EVENT_TYPE: Record<DeltaChannel, BridgeInboundEvent["type"]> = {
  assistant: "assistant.delta",
  thinking: "thinking.delta",
};

/**
 * Model output is attacker-influenceable: a prompt injection can make the model
 * reproduce an escape sequence in its own reply, which never passes the
 * tool-dispatch sanitizer. Deltas arrive in fragments, so a sequence can
 * straddle a boundary — the trailing partial is held in the map context and
 * joined to the next fragment rather than sanitized in isolation.
 */
function sanitizeDelta(
  ctx: StreamMapContext | undefined,
  channel: DeltaChannel,
  token: string,
): string {
  if (!ctx) return stripTerminalControlSequences(token);
  const [head, tail] = splitPendingControlTail(ctx.pendingDelta[channel] + token);
  ctx.pendingDelta[channel] = tail;
  return stripTerminalControlSequences(head);
}

/**
 * Held fragments must still reach the screen once the burst ends. What is
 * still incomplete at that point never became a real sequence, so it is
 * discarded rather than painted with its introducer bytes shaved off.
 */
function flushDelta(
  ctx: StreamMapContext | undefined,
  channel: DeltaChannel,
): readonly BridgeInboundEvent[] {
  if (!ctx || ctx.pendingDelta[channel].length === 0) return [];
  const [complete] = splitPendingControlTail(ctx.pendingDelta[channel]);
  const text = stripTerminalControlSequences(complete);
  ctx.pendingDelta[channel] = "";
  if (text.length === 0) return [];
  return [{ type: DELTA_EVENT_TYPE[channel], text } as BridgeInboundEvent];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function dataOf(event: ReactorLikeEvent): Record<string, unknown> {
  return asRecord(event.data) ?? {};
}

function stringifyDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  try {
    const s = JSON.stringify(value);
    return s.length > 0 ? s : undefined;
  } catch {
    return String(value);
  }
}

function trackCall(
  ctx: StreamMapContext | undefined,
  callId: string | undefined,
  name: string | undefined,
  args?: unknown,
): void {
  if (!ctx || !callId) return;
  if (name && name.length > 0) ctx.callIdToName.set(callId, name);
  if (args !== undefined) {
    const detail = stringifyDetail(args);
    if (detail !== undefined) ctx.callIdToArgs.set(callId, detail);
  }
}

function resolveToolName(
  ctx: StreamMapContext | undefined,
  callId: string | undefined,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  if (ctx && callId) {
    const tracked = ctx.callIdToName.get(callId);
    if (tracked) return tracked;
  }
  if (callId && callId.length > 0) return callId;
  return "tool";
}

function toolCallEvent(
  name: string,
  detail: string | undefined,
  callId?: string,
): BridgeInboundEvent {
  return {
    type: "tool_call",
    name,
    ...(detail !== undefined ? { detail } : {}),
    ...(callId !== undefined ? { callId } : {}),
  };
}

/**
 * Map one production-shaped reactor/stream event into zero or more bridge events.
 *
 * A `ctx` carries the cross-event bookkeeping: callId→name resolution for a
 * tool.done without result.name, retry boundaries, and the suppressions that
 * keep one paint per thing (connector.reply after deltas, no double tool_call).
 * Stateless calls remain safe for fixtures and simple unit tests.
 */
export function mapProductionEvent(
  event: ReactorLikeEvent,
  ctx?: StreamMapContext,
): readonly BridgeInboundEvent[] {
  const flushed: BridgeInboundEvent[] = [];
  if (event.type !== "inference.text.delta") {
    flushed.push(...flushDelta(ctx, "assistant"));
  }
  if (event.type !== "inference.thinking.delta") {
    flushed.push(...flushDelta(ctx, "thinking"));
  }
  // The error handoff only survives to the very next event; consume it here so
  // anything other than the retry start it was meant for expires the boundary
  // and keeps the error row.
  const handoff = ctx?.errorRollbackArmed === true;
  if (ctx) ctx.errorRollbackArmed = false;
  const expired = handoff && !recoversErrorHandoff(event.type) ? [ATTEMPT_CLEAR] : [];
  const mapped = mapEvent(event, ctx, handoff);
  return [...flushed, ...expired, ...mapped];
}

function mapEvent(
  event: ReactorLikeEvent,
  ctx?: StreamMapContext,
  errorRollbackHandoff = false,
): readonly BridgeInboundEvent[] {
  const { type } = event;
  const data = dataOf(event);

  switch (type) {
    case "message.received": {
      const message = asRecord(data.message);
      const content = typeof message?.content === "string" ? message.content : "";
      const attachments = Array.isArray(message?.attachments)
        ? (message.attachments as { name?: string }[])
        : [];
      const attachmentText =
        attachments.length > 0
          ? `\n[Attached ${attachments.length} image${attachments.length === 1 ? "" : "s"}: ${attachments.map((a) => a.name ?? "image").join(", ")}]`
          : "";
      const full = `${content}${attachmentText}`;
      // The boundary must never straddle a user row: a later retry retracting
      // across it would erase the operator's own message.
      const disarmed = disarmAttempt(ctx);
      if (full.trim().length === 0) return disarmed;
      return [...disarmed, { type: "user", text: full }];
    }

    case "inference.start": {
      const recovered = errorRollbackHandoff;
      if (ctx) {
        if (recovered) forgetAttemptLocalState(ctx);
        ctx.hadTextDelta = false;
        ctx.attemptArmed = true;
        ctx.attemptCallIds = new Set(ctx.callIdToName.keys());
        ctx.pendingProviderFailure = false;
        ctx.pendingProviderError = undefined;
      }
      return [
        ...(recovered ? [ATTEMPT_ROLLBACK] : []),
        ATTEMPT_MARK,
        { type: "run", state: "busy" },
      ];
    }

    case "inference.done":
      // Cycle settled: disarm so a pre-commit retry belonging to the *next*
      // cycle cannot retract this one's rows.
      if (ctx) {
        ctx.pendingProviderFailure = false;
        ctx.pendingProviderError = undefined;
      }
      return disarmAttempt(ctx);

    case "inference.retry": {
      const armed = ctx?.attemptArmed === true;
      if (ctx) ctx.attemptArmed = false;
      // A retry that arrives with nothing armed is the harness's pre-commit
      // kind: the failed attempt never streamed, so there is nothing to undo.
      if (!armed && !errorRollbackHandoff) return [];
      if (ctx) forgetAttemptLocalState(ctx);
      return [ATTEMPT_ROLLBACK];
    }

    case "inference.text.delta": {
      const token = typeof data.token === "string" ? data.token : "";
      if (token.length === 0) return [];
      if (ctx) ctx.hadTextDelta = true;
      const text = sanitizeDelta(ctx, "assistant", token);
      if (text.length === 0) return [];
      return [{ type: "assistant.delta", text }];
    }

    case "inference.thinking.delta": {
      // Chain-of-thought is not transcript content: it coalesces into its own
      // dim "thinking" row rather than interleaving with system chrome.
      const token = typeof data.token === "string" ? data.token : "";
      if (token.length === 0) return [];
      const text = sanitizeDelta(ctx, "thinking", token);
      if (text.length === 0) return [];
      return [{ type: "thinking.delta", text }];
    }

    case "inference.tool_call.start": {
      const name = typeof data.name === "string" ? data.name : "tool";
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      trackCall(ctx, callId, name);
      // Prefer painting at end with final arguments; early start is tracking only
      // when we have a callId. Without callId, emit immediately.
      if (ctx && callId) return [];
      return [toolCallEvent(name, undefined, callId)];
    }

    case "inference.tool_call.delta": {
      const fragment = typeof data.argumentFragment === "string" ? data.argumentFragment : "";
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      if (ctx && callId && fragment.length > 0) {
        const prev = ctx.callIdToArgs.get(callId) ?? "";
        ctx.callIdToArgs.set(callId, prev + fragment);
      }
      // Deltas coalesce into the final tool_call at end — no intermediate rows.
      return [];
    }

    case "inference.tool_call.end": {
      const name = typeof data.name === "string" ? data.name : "tool";
      const callId = typeof data.callId === "string" ? data.callId : undefined;
      const streamed = ctx && callId ? ctx.callIdToArgs.get(callId) : undefined;
      const detail = data.arguments !== undefined ? stringifyDetail(data.arguments) : streamed;
      trackCall(ctx, callId, name, data.arguments !== undefined ? data.arguments : streamed);
      if (ctx && callId) ctx.emittedToolCalls.add(callId);
      return [toolCallEvent(name, detail, callId)];
    }

    case "tool.start": {
      const call = asRecord(data.call);
      const name = typeof call?.name === "string" ? call.name : "tool";
      const callId =
        typeof call?.id === "string"
          ? call.id
          : typeof call?.callId === "string"
            ? call.callId
            : undefined;
      trackCall(ctx, callId, name);
      // tool.start opens no row of its own; skip if tool_call already painted.
      if (ctx && callId && ctx.emittedToolCalls.has(callId)) return [];
      if (ctx && callId) ctx.emittedToolCalls.add(callId);
      return [toolCallEvent(name, undefined, callId)];
    }

    case "tool.done": {
      const result = asRecord(data.result);
      const callId = typeof result?.callId === "string" ? result.callId : undefined;
      const explicitName = typeof result?.name === "string" ? result.name : undefined;
      const name = resolveToolName(ctx, callId, explicitName);
      const detail = stringifyDetail(result?.content);
      const isError = result?.isError === true;
      if (ctx && callId) {
        ctx.callIdToName.delete(callId);
        ctx.callIdToArgs.delete(callId);
        ctx.emittedToolCalls.delete(callId);
      }
      const out: BridgeInboundEvent = {
        type: "tool_result",
        name,
        ...(detail !== undefined ? { detail } : {}),
        ...(isError ? { isError: true } : {}),
        ...(callId !== undefined ? { callId } : {}),
      };
      return [out, { type: "tool.boundary" }];
    }

    case "connector.reply": {
      const content = typeof data.content === "string" ? data.content : "";
      if (ctx?.pendingProviderFailure === true) {
        ctx.pendingProviderFailure = false;
        ctx.hadTextDelta = false;
        const error = ctx.pendingProviderError ?? {
          category: "unknown",
          message: "inference error",
        };
        ctx.pendingProviderError = undefined;
        const providerId = error.providerId ?? ctx.providerId ?? "Unknown";
        const providerLabel =
          error.providerId === undefined || error.providerId === ctx.providerId
            ? ctx.providerLabel
            : undefined;
        return [
          {
            type: "assistant",
            text: terminalProviderFailureMessage(providerId, error, providerLabel),
          },
        ];
      }
      if (ctx?.hadTextDelta) {
        ctx.hadTextDelta = false;
        // Text already painted via assistant.delta; the reply would repeat it.
        return [];
      }
      if (content.trim().length === 0) return [];
      return [{ type: "assistant", text: stripTerminalControlSequences(content) }];
    }

    case "reactor.done":
      if (ctx) {
        ctx.hadTextDelta = false;
        ctx.pendingProviderFailure = false;
        ctx.pendingProviderError = undefined;
      }
      return [...disarmAttempt(ctx), { type: "run", state: "idle" }, { type: "tool.boundary" }];

    case "reactor.error": {
      const error = typeof data.error === "string" ? data.error : "reactor error";
      if (ctx) ctx.hadTextDelta = false;
      return [
        ...disarmAttempt(ctx),
        { type: "error", message: error },
        { type: "run", state: "idle" },
      ];
    }

    case "inference.error": {
      // Hand the armed boundary to the next event rather than disarming: a
      // committed retry start must still retract the failed attempt. Terminal
      // failures are surfaced once by the runner after agent.send rejects;
      // provider diagnostics remain in the event stream for observability only.
      if (ctx?.attemptArmed === true) {
        ctx.attemptArmed = false;
        ctx.errorRollbackArmed = true;
      }
      if (ctx) {
        ctx.pendingProviderFailure = true;
        const rawError = asRecord(data.error);
        ctx.pendingProviderError = {
          category: typeof rawError?.category === "string" ? rawError.category : "unknown",
          message: typeof rawError?.message === "string" ? rawError.message : "inference error",
          ...(typeof rawError?.statusCode === "number" ? { statusCode: rawError.statusCode } : {}),
          ...(typeof rawError?.providerId === "string" ? { providerId: rawError.providerId } : {}),
        };
      }
      return [];
    }

    default:
      return [];
  }
}

/**
 * Stateless reactor → bridge map (fixture-friendly). Prefer
 * `mapProductionEvent(event, ctx)` for live sessions.
 */
export function mapReactorLike(event: ReactorLikeEvent): readonly BridgeInboundEvent[] {
  return mapProductionEvent(event);
}

/** Fold a sequence of production events through a shared map context. */
export function mapProductionSequence(
  events: readonly ReactorLikeEvent[],
  ctx: StreamMapContext = createStreamMapContext(),
): BridgeInboundEvent[] {
  const out: BridgeInboundEvent[] = [];
  for (const event of events) {
    out.push(...mapProductionEvent(event, ctx));
  }
  return out;
}
