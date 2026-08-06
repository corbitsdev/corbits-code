/**
 * Pure observe mappers — child stream / bridge events → StreamRow.
 *
 * Shell owns enter/leave + appendObserveStreamRow; hosts use these helpers to
 * turn live child reactor events (or already-mapped bridge events) into rows
 * before painting the observe view. No renderer deps.
 */

import { toolCallRow } from "./diff.js"
import { toolResultRow } from "./mcp-view.js"
import type { StreamRow } from "./stream.js"
import {
  createStreamMapContext,
  mapProductionEvent,
  type BridgeInboundEvent,
  type ReactorLikeEvent,
  type StreamMapContext,
} from "./stream-event-map.js"

/**
 * Map one canonical bridge inbound event to a paint row.
 * Non-row events (run state, tool.boundary, assistant.delta) return null —
 * callers coalesce deltas / apply run state themselves when needed.
 */
export function rowFromBridgeEvent(event: BridgeInboundEvent): StreamRow | null {
  switch (event.type) {
    case "user":
      return { role: "user", text: event.text }
    case "assistant":
      return { role: "assistant", text: event.text }
    case "tool_call":
      return toolCallRow({
        name: event.name,
        ...(event.detail !== undefined ? { arguments: event.detail } : {}),
      })
    case "tool_result":
      return toolResultRow({
        name: event.name,
        content: event.detail ?? (event.isError ? "error" : "ok"),
        isError: event.isError === true,
      })
    case "system":
      return { role: "system", text: event.text }
    case "error":
      return { role: "system", text: event.message, meta: "error" }
    default:
      return null
  }
}

/**
 * Map zero or more bridge events to paint rows (filters nulls).
 * Does not coalesce assistant.delta — those stay non-rows.
 */
export function rowsFromBridgeEvents(
  events: readonly BridgeInboundEvent[],
): StreamRow[] {
  const rows: StreamRow[] = []
  for (const event of events) {
    const row = rowFromBridgeEvent(event)
    if (row) rows.push(row)
  }
  return rows
}

/**
 * Map one child reactor/stream event to zero or more StreamRows for observe.
 * Pass a shared StreamMapContext across a live child session for tool-name
 * fidelity (same as mapProductionEvent).
 */
export function mapChildStreamEvent(
  event: ReactorLikeEvent,
  ctx?: StreamMapContext,
): StreamRow[] {
  return rowsFromBridgeEvents(mapProductionEvent(event, ctx))
}

/**
 * Fold a sequence of child events through a shared map context into rows.
 * Suitable for seeding observe from a retained child event log.
 */
export function mapChildStreamSequence(
  events: readonly ReactorLikeEvent[],
  ctx: StreamMapContext = createStreamMapContext(),
): StreamRow[] {
  const rows: StreamRow[] = []
  for (const event of events) {
    rows.push(...mapChildStreamEvent(event, ctx))
  }
  return rows
}

/**
 * Coalesce assistant.delta tokens into a single assistant row when the
 * sequence ends or a non-delta event arrives. Useful for pure seed paths
 * that do not run the live bridge bag.
 */
export function rowsFromBridgeEventsCoalesced(
  events: readonly BridgeInboundEvent[],
): StreamRow[] {
  const rows: StreamRow[] = []
  let deltaBuf = ""
  const flushDelta = (): void => {
    if (deltaBuf.length === 0) return
    rows.push({ role: "assistant", text: deltaBuf })
    deltaBuf = ""
  }
  for (const event of events) {
    if (event.type === "assistant.delta") {
      deltaBuf += event.text
      continue
    }
    flushDelta()
    const row = rowFromBridgeEvent(event)
    if (row) rows.push(row)
  }
  flushDelta()
  return rows
}
