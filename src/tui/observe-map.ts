/**
 * Pure observe mappers — child stream / bridge events → StreamRow.
 *
 * Shell owns enter/leave + appendObserveStreamRow; hosts use these helpers to
 * turn live child reactor events (or already-mapped bridge events) into rows
 * before painting the observe view. No renderer deps.
 */

import { toolCallRow } from "./diff.js";
import { toolResultRow } from "./mcp-view.js";
import { pushToolCall, pushToolResult } from "./tool-rows.js";
import type { StreamRow } from "./stream.js";
import {
  createStreamMapContext,
  mapProductionEvent,
  type BridgeInboundEvent,
  type ReactorLikeEvent,
  type StreamMapContext,
} from "./stream-event-map.js";

/**
 * Map one canonical bridge inbound event to a paint row.
 * Non-row events (run state, tool.boundary, assistant.delta) return null —
 * callers coalesce deltas / apply run state themselves when needed.
 */
export function rowFromBridgeEvent(event: BridgeInboundEvent): StreamRow | null {
  switch (event.type) {
    case "user":
      return { role: "user", text: event.text };
    case "assistant":
      return { role: "assistant", text: event.text };
    case "tool_call":
      return toolCallRow({
        name: event.name,
        ...(event.detail !== undefined ? { arguments: event.detail } : {}),
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
      });
    case "tool_result":
      return toolResultRow({
        name: event.name,
        content: event.detail ?? (event.isError ? "error" : "ok"),
        isError: event.isError === true,
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
      });
    case "system":
      return { role: "system", text: event.text };
    case "error":
      return { role: "system", text: event.message, meta: "error" };
    default:
      return null;
  }
}

/**
 * Map zero or more bridge events to paint rows (filters nulls).
 * Does not coalesce assistant.delta — those stay non-rows.
 *
 * Tool events are folded rather than mapped one-to-one: a call and its result
 * are one row, and a repeat of a call collapses onto the row it repeats.
 */
export function rowsFromBridgeEvents(events: readonly BridgeInboundEvent[]): StreamRow[] {
  const rows: StreamRow[] = [];
  const attempt: AttemptBoundary = { at: null };
  for (const event of events) {
    pushBridgeEvent(rows, event, attempt);
  }
  return rows;
}

/**
 * Row index where the inference attempt in progress began. A failed attempt is
 * re-streamed from scratch, so its rows are retracted rather than appended to.
 */
interface AttemptBoundary { at: number | null }

/** Fold one bridge event onto a row list, merging tool calls with their answers. */
function pushBridgeEvent(
  rows: StreamRow[],
  event: BridgeInboundEvent,
  attempt: AttemptBoundary = { at: null },
): void {
  if (event.type === "attempt") {
    if (event.action === "mark") attempt.at = rows.length;
    else if (event.action === "clear") attempt.at = null;
    else {
      if (attempt.at !== null && attempt.at < rows.length) {
        rows.length = attempt.at;
      }
      attempt.at = null;
    }
    return;
  }
  if (event.type === "tool_call") {
    pushToolCall(rows, {
      name: event.name,
      ...(event.detail !== undefined ? { arguments: event.detail } : {}),
      ...(event.callId !== undefined ? { callId: event.callId } : {}),
    });
    return;
  }
  if (event.type === "tool_result") {
    pushToolResult(rows, {
      name: event.name,
      content: event.detail ?? (event.isError ? "error" : "ok"),
      isError: event.isError === true,
      ...(event.callId !== undefined ? { callId: event.callId } : {}),
    });
    return;
  }
  const row = rowFromBridgeEvent(event);
  if (row) rows.push(row);
}

/**
 * Map one child reactor/stream event to zero or more StreamRows for observe.
 * Pass a shared StreamMapContext across a live child session for tool-name
 * fidelity (same as mapProductionEvent).
 */
export function mapChildStreamEvent(event: ReactorLikeEvent, ctx?: StreamMapContext): StreamRow[] {
  return rowsFromBridgeEvents(mapProductionEvent(event, ctx));
}

/**
 * Fold a sequence of child events through a shared map context into rows.
 * Suitable for seeding observe from a retained child event log.
 */
export function mapChildStreamSequence(
  events: readonly ReactorLikeEvent[],
  ctx: StreamMapContext = createStreamMapContext(),
): StreamRow[] {
  const rows: StreamRow[] = [];
  const attempt: AttemptBoundary = { at: null };
  for (const event of events) {
    for (const mapped of mapProductionEvent(event, ctx)) {
      pushBridgeEvent(rows, mapped, attempt);
    }
  }
  return rows;
}

/**
 * Coalesce assistant.delta tokens into a single assistant row when the
 * sequence ends or a non-delta event arrives. Useful for pure seed paths
 * that do not run the live bridge bag.
 */
export function rowsFromBridgeEventsCoalesced(events: readonly BridgeInboundEvent[]): StreamRow[] {
  const rows: StreamRow[] = [];
  let deltaBuf = "";
  const flushDelta = (): void => {
    if (deltaBuf.length === 0) return;
    rows.push({ role: "assistant", text: deltaBuf });
    deltaBuf = "";
  };
  for (const event of events) {
    if (event.type === "assistant.delta") {
      deltaBuf += event.text;
      continue;
    }
    flushDelta();
    pushBridgeEvent(rows, event);
  }
  flushDelta();
  return rows;
}
