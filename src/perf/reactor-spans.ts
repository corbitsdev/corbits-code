/**
 * Map reactor stream events onto the shared PerfTrace span tree.
 *
 * Always-on, local-only. Nesting:
 *   turn
 *     inference
 *       inference.ttft   (start → first content-bearing delta)
 *       inference.stream (first delta → inference.done)
 *     tool (per invocation)
 *     permission.wait   (operator ask; diagnostic nested category — wall time
 *                        overlaps tool; exclusive attribution already excludes
 *                        nested categories, so double-count is intentional)
 *     subagent          (task fleet child wall)
 *
 * Single-primary assumption: the session run-sink owns one
 * `createPerfReactorObserver`. Process-wide `currentTurnId()` is published only
 * by that primary so permission.wait / subagent can nest outside the observer.
 * Do not create concurrent observers that also call ensureTurn — they would
 * overwrite the slot. Tests call `clear()` (and observer `reset()`) between cases.
 */

import type { ReactorEmittedEvent } from "@intx/inference";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { end, start } from "./index.js";
import { getActiveTurnId, setActiveTurnId } from "./active-turn.js";

/** Content-bearing events that end TTFT and open the stream phase. */
const FIRST_TOKEN_TYPES: ReadonlySet<string> = new Set([
  "inference.text.delta",
  "inference.thinking.delta",
  "inference.refusal.delta",
  "inference.tool_call.start",
  "inference.tool_call.delta",
  "inference.tool_call.end",
  "inference.citation",
  "inference.image_output",
  "inference.code_execution.start",
  "inference.code_execution.delta",
  "inference.code_execution.result",
  "inference.block.signature",
  "inference.thinking.redacted",
]);

export interface PerfReactorObserver {
  observe(event: ReactorEmittedEvent): void;
  reset(): void;
  /** Opaque PerfTrace id of the open turn span, or null when no turn is open. */
  currentTurnId(): string | null;
}

/**
 * Process-wide open-turn id from the most recently active reactor observer.
 * Permission-wait and subagent spans nest under this when present.
 * Owned by `active-turn.ts`; cleared on observer close/reset and PerfTrace clear().
 */
export function currentTurnId(): string | null {
  return getActiveTurnId();
}

interface ObserverState {
  turnId: string | null;
  inferenceId: string | null;
  ttftId: string | null;
  streamId: string | null;
  /** Tool calls still expected before the current turn can close. */
  pendingTools: number;
  /** Open tool spans keyed by callId. */
  openTools: Map<string, string>;
}

function emptyState(): ObserverState {
  return {
    turnId: null,
    inferenceId: null,
    ttftId: null,
    streamId: null,
    pendingTools: 0,
    openTools: new Map(),
  };
}

function toolCallCount(event: ReactorEmittedEvent): number {
  if (!onTurnBoundary(event)) return 0;
  const data = event.data as {
    turn?: { content?: readonly { type: string }[] };
  };
  const content = data.turn?.content;
  if (content === undefined) return 0;
  let n = 0;
  for (const block of content) {
    if (block.type === "tool_call") n += 1;
  }
  return n;
}

function callIdFromToolStart(event: ReactorEmittedEvent): string | undefined {
  if (event.type !== "tool.start") return undefined;
  const data = event.data as { call?: { id?: unknown } };
  const id = data.call?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function callIdFromToolDone(event: ReactorEmittedEvent): string | undefined {
  if (event.type !== "tool.done") return undefined;
  const data = event.data as { result?: { callId?: unknown } };
  const id = data.result?.callId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function modelTags(event: ReactorEmittedEvent): Record<string, unknown> | undefined {
  if (event.type === "inference.start") {
    const data = event.data as { model?: unknown };
    if (typeof data.model === "string" && data.model.length > 0) {
      return { model_id: data.model };
    }
    return undefined;
  }
  if (onTurnBoundary(event)) {
    const data = event.data as {
      source?: { provider?: unknown; model?: unknown };
      usage?: { input?: unknown; output?: unknown };
    };
    const tags: Record<string, unknown> = {};
    if (typeof data.source?.provider === "string") tags.provider_id = data.source.provider;
    if (typeof data.source?.model === "string") tags.model_id = data.source.model;
    if (typeof data.usage?.input === "number") tags.input_tokens = data.usage.input;
    if (typeof data.usage?.output === "number") tags.output_tokens = data.usage.output;
    return Object.keys(tags).length > 0 ? tags : undefined;
  }
  return undefined;
}

/**
 * Observe reactor events and open/close nested PerfTrace spans.
 * One observer per run-sink; call `reset` when the sink resets.
 */
export function createPerfReactorObserver(): PerfReactorObserver {
  let state = emptyState();

  function endIfOpen(id: string | null, tags?: Record<string, unknown>): void {
    if (id === null || id.length === 0) return;
    end(id, tags);
  }

  function closeInferenceTree(tags?: Record<string, unknown>): void {
    endIfOpen(state.streamId);
    state.streamId = null;
    // No first-token event: fold TTFT into the full inference window.
    endIfOpen(state.ttftId);
    state.ttftId = null;
    endIfOpen(state.inferenceId, tags);
    state.inferenceId = null;
  }

  function closeOpenTools(): void {
    for (const spanId of state.openTools.values()) {
      endIfOpen(spanId);
    }
    state.openTools.clear();
  }

  /**
   * Single exit for ending a turn: close orphan tool spans, then the turn.
   * Inference tree must already be closed (or will be via abandonTurn).
   * Clears the process-wide active turn when this observer owns it.
   */
  function closeTurn(): void {
    closeOpenTools();
    endIfOpen(state.turnId);
    if (state.turnId !== null && getActiveTurnId() === state.turnId) {
      setActiveTurnId(null);
    }
    state.turnId = null;
    state.pendingTools = 0;
  }

  /** Abandon the whole open tree (inference + tools + turn). */
  function abandonTurn(): void {
    closeInferenceTree();
    closeTurn();
  }

  function ensureTurn(): string {
    if (state.turnId === null) {
      state.turnId = start("turn");
      setActiveTurnId(state.turnId);
    }
    return state.turnId;
  }

  function onFirstToken(): void {
    if (state.inferenceId === null || state.streamId !== null) return;

    endIfOpen(state.ttftId);
    state.ttftId = null;
    state.streamId = start("inference.stream", { parentId: state.inferenceId });
  }

  function observe(event: ReactorEmittedEvent): void {
    const type = event.type;

    if (type === "inference.start") {
      // Always abandon any prior turn before opening a new one. Interrupt mid-
      // inference or mid-tool must not nest the next call under a stale turn or
      // leave orphan tool spans in the process-wide open map.
      abandonTurn();
      const turnId = ensureTurn();
      const tags = modelTags(event);
      state.inferenceId = start("inference", {
        parentId: turnId,
        ...(tags !== undefined ? { tags } : {}),
      });
      state.ttftId = start("inference.ttft", { parentId: state.inferenceId });
      state.streamId = null;
      return;
    }

    if (FIRST_TOKEN_TYPES.has(type)) {
      onFirstToken();
      return;
    }

    if (onTurnBoundary(event)) {
      const tags = modelTags(event);
      closeInferenceTree(tags);
      state.pendingTools = toolCallCount(event);
      if (state.pendingTools === 0) {
        closeTurn();
      }
      return;
    }

    if (type === "inference.error") {
      closeInferenceTree();
      // Drop the turn if nothing is waiting on tools; otherwise keep it open
      // so in-flight tool spans can still close under it.
      if (state.pendingTools === 0) {
        closeTurn();
      }
      return;
    }

    if (type === "tool.start") {
      const turnId = state.turnId;
      if (turnId === null) return;
      const callId = callIdFromToolStart(event);
      if (callId === undefined) return;
      if (state.openTools.has(callId)) return;
      const spanId = start("tool", {
        parentId: turnId,
        tags: { tool_id: callId },
      });
      state.openTools.set(callId, spanId);
      return;
    }

    if (type === "tool.done") {
      const callId = callIdFromToolDone(event);
      if (callId !== undefined) {
        const openId = state.openTools.get(callId);
        if (openId !== undefined) {
          end(openId);
          state.openTools.delete(callId);
        } else if (state.turnId !== null) {
          // Blocked tools emit tool.done without tool.start.
          const spanId = start("tool", {
            parentId: state.turnId,
            tags: { tool_id: callId },
          });
          end(spanId);
        }
      }
      if (state.pendingTools > 0) {
        state.pendingTools -= 1;
      }
      if (state.pendingTools === 0 && state.inferenceId === null && state.turnId !== null) {
        closeTurn();
      }
      return;
    }
  }

  function reset(): void {
    abandonTurn();
    state = emptyState();
  }

  return {
    observe,
    reset,
    currentTurnId: () => state.turnId,
  };
}
