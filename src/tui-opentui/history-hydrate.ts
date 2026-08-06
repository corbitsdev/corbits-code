/**
 * Pure history hydrate — content blocks / turns → StreamRow[].
 *
 * Mirrors product-host `rowFromHistoryBlock` so resume / history.hydrate can
 * paint without a renderer. No OpenTUI or Ink deps.
 */

import type { StreamRow } from "./stream.js"

/**
 * Loose content-block shape from `history.hydrate` / turns-to-blocks.
 * Matches product-host; extra fields (id, callId, arguments) are tolerated.
 */
export type HistoryBlock = {
  readonly type: string
  readonly content?: string
  readonly name?: string
  readonly message?: string
  readonly isError?: boolean
  /** tool_call argument payload when `content` is absent (ContentBlockData). */
  readonly arguments?: string
}

function asHistoryBlock(raw: unknown): HistoryBlock | null {
  if (raw === null || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (typeof o.type !== "string") return null
  const block: HistoryBlock = { type: o.type }
  const out: {
    type: string
    content?: string
    name?: string
    message?: string
    isError?: boolean
    arguments?: string
  } = { type: o.type }
  if (typeof o.content === "string") out.content = o.content
  if (typeof o.name === "string") out.name = o.name
  if (typeof o.message === "string") out.message = o.message
  if (typeof o.isError === "boolean") out.isError = o.isError
  if (typeof o.arguments === "string") out.arguments = o.arguments
  return out as HistoryBlock
}

/**
 * Map one content block to a transcript row, or null when the block type is
 * not painted (tasks, plan, view, unknown).
 *
 * Mirror of product-host `rowFromHistoryBlock`; tool_call also accepts
 * `arguments` when `content` is missing (live ContentBlockData shape).
 */
export function rowFromHistoryBlock(block: HistoryBlock): StreamRow | null {
  switch (block.type) {
    case "user":
      return { role: "user", text: block.content ?? "" }
    case "text":
    case "reply":
      return { role: "assistant", text: block.content ?? "" }
    case "thinking":
      return { role: "system", text: block.content ?? "", meta: "thinking" }
    case "tool_call": {
      const text =
        block.content ??
        (block.arguments !== undefined && block.arguments.length > 0
          ? block.arguments
          : "…")
      return {
        role: "tool",
        text,
        meta: block.name ?? "tool",
      }
    }
    case "tool_result":
      return {
        role: "tool",
        text: block.content ?? (block.isError ? "error" : "ok"),
        meta: block.isError
          ? `${block.name ?? "tool"}!`
          : (block.name ?? "tool"),
      }
    case "error":
      return { role: "system", text: block.message ?? "error", meta: "error" }
    default:
      return null
  }
}

/**
 * Map a `history.hydrate` payload (array of content blocks) to StreamRow[].
 * Skips non-objects and unpaintable block types.
 */
export function hydrateHistoryRows(blocks: unknown): StreamRow[] {
  if (!Array.isArray(blocks)) return []
  const rows: StreamRow[] = []
  for (const raw of blocks) {
    const block = asHistoryBlock(raw)
    if (!block) continue
    const row = rowFromHistoryBlock(block)
    if (row) rows.push(row)
  }
  return rows
}

/**
 * Convenience: map an already-typed block list (e.g. from turns-to-blocks).
 */
export function rowsFromHistoryBlocks(
  blocks: readonly HistoryBlock[],
): StreamRow[] {
  const rows: StreamRow[] = []
  for (const block of blocks) {
    const row = rowFromHistoryBlock(block)
    if (row) rows.push(row)
  }
  return rows
}
