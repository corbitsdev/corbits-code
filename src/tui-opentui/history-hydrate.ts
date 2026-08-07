/**
 * Pure history hydrate — content blocks / turns → StreamRow[].
 *
 * Mirrors product-host `rowFromHistoryBlock` so resume / history.hydrate can
 * paint without a renderer. No OpenTUI or Ink deps.
 */

import { validateView, viewToLines } from "../tui/view/index.js"
import { toolCallRow } from "./diff.js"
import { toolResultRow } from "./mcp-view.js"
import type { StreamRow } from "./stream.js"
import { TOOL_DETAIL_WIDTH } from "./tool-args.js"
import { pushToolCall, pushToolResult } from "./tool-rows.js"

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
  /**
   * Call id carried by a `tool_call` / `tool_result` block. Two saved calls to
   * the same tool are indistinguishable by name alone — a resumed transcript
   * with parallel sub-agent dispatches needs this to pair each result with
   * its own call rather than the newest pending call of that name.
   */
  readonly callId?: string
  /** view block payload — validated before it reaches the layout pass. */
  readonly node?: unknown
  /** plan block payload. */
  readonly steps?: unknown
  /** tasks block payload. */
  readonly tasks?: unknown
}

/** Body for a resumed error the transcript recorded without its message. */
export const MISSING_ERROR_DETAIL = "this step failed and the details were not saved"

/** Bodies for blocks that survived to hydration carrying nothing paintable. */
export const EMPTY_VIEW_DETAIL = "this reply was a view with no text"
export const EMPTY_PLAN_DETAIL = "plan with no steps"
export const EMPTY_TASKS_DETAIL = "task list with no tasks"

function asHistoryBlock(raw: unknown): HistoryBlock | null {
  if (raw === null || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (typeof o.type !== "string") return null
  const out: {
    type: string
    content?: string
    name?: string
    message?: string
    isError?: boolean
    arguments?: string
    callId?: string
    node?: unknown
    steps?: unknown
    tasks?: unknown
  } = { type: o.type }
  if (typeof o.content === "string") out.content = o.content
  if (typeof o.name === "string") out.name = o.name
  if (typeof o.message === "string") out.message = o.message
  if (typeof o.isError === "boolean") out.isError = o.isError
  if (typeof o.arguments === "string") out.arguments = o.arguments
  if (typeof o.callId === "string") out.callId = o.callId
  if (o.node !== undefined) out.node = o.node
  if (o.steps !== undefined) out.steps = o.steps
  if (o.tasks !== undefined) out.tasks = o.tasks
  return out as HistoryBlock
}

/**
 * A view tree as plain transcript text. Full view rendering (borders, grid
 * alignment, tone) is not part of hydration; the layout pass is reused only to
 * recover the words, because a resumed reply that was a view must not vanish.
 */
function viewText(node: unknown): string {
  const result = validateView(node)
  if (!result.ok) return ""
  return viewToLines(result.node, TOOL_DETAIL_WIDTH)
    .map((line) => line.map((segment) => segment.text).join("").trimEnd())
    .join("\n")
    .trim()
}

function planText(steps: unknown): string {
  if (!Array.isArray(steps)) return ""
  const lines: string[] = []
  for (const raw of steps) {
    if (raw === null || typeof raw !== "object") continue
    const step = raw as Record<string, unknown>
    const file = typeof step.file === "string" ? step.file : ""
    const action = typeof step.action === "string" ? step.action : ""
    const reason = typeof step.reason === "string" ? step.reason : ""
    const head = [action, file].filter((part) => part.length > 0).join(" ")
    const text = reason.length > 0 ? `${head} — ${reason}` : head
    if (text.length > 0) lines.push(`- ${text}`)
  }
  return lines.join("\n")
}

function tasksText(tasks: unknown): string {
  if (!Array.isArray(tasks)) return ""
  const lines: string[] = []
  for (const raw of tasks) {
    if (raw === null || typeof raw !== "object") continue
    const task = raw as Record<string, unknown>
    const title = typeof task.title === "string" ? task.title : ""
    if (title.length === 0) continue
    const status = typeof task.status === "string" ? task.status : ""
    lines.push(status.length > 0 ? `- ${title} (${status})` : `- ${title}`)
  }
  return lines.join("\n")
}

/**
 * Map one content block to a transcript row, or null when the block type is
 * unknown.
 *
 * view / plan / tasks get a degraded text row rather than being dropped: a
 * resumed session that answered through a view would otherwise paint the
 * question and nothing else, with no marker that anything was lost.
 *
 * tool_call also accepts `arguments` when `content` is missing (live
 * ContentBlockData shape).
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
      const args = callArguments(block)
      return toolCallRow({
        name: block.name ?? "tool",
        ...(args !== undefined ? { arguments: args } : {}),
        ...(block.callId !== undefined ? { callId: block.callId } : {}),
      })
    }
    case "tool_result":
      return toolResultRow({
        name: block.name ?? "tool",
        content: block.content ?? (block.isError ? "error" : "ok"),
        isError: block.isError === true,
        ...(block.callId !== undefined ? { callId: block.callId } : {}),
      })
    case "view": {
      const text = viewText(block.node) || block.content?.trim() || ""
      return {
        role: "assistant",
        text: text.length > 0 ? text : EMPTY_VIEW_DETAIL,
        markdown: false,
      }
    }
    case "plan": {
      const text = planText(block.steps)
      return {
        role: "system",
        text: text.length > 0 ? text : EMPTY_PLAN_DETAIL,
        meta: "plan",
      }
    }
    case "tasks": {
      const text = tasksText(block.tasks)
      return {
        role: "system",
        text: text.length > 0 ? text : EMPTY_TASKS_DETAIL,
        meta: "tasks",
      }
    }
    case "error":
      return {
        role: "system",
        text: block.message ?? MISSING_ERROR_DETAIL,
        meta: "error",
      }
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
    if (block) pushHistoryBlock(rows, block)
  }
  return rows
}

/** Argument payload of a tool_call block, wherever the block carries it. */
function callArguments(block: HistoryBlock): string | undefined {
  if (block.content !== undefined) return block.content
  return block.arguments !== undefined && block.arguments.length > 0
    ? block.arguments
    : undefined
}

/**
 * Fold one block onto a row list. Tool blocks are not one row each: a call and
 * the result answering it share a row, and a repeated call collapses onto the
 * row it repeats — the same shape a live turn paints.
 */
function pushHistoryBlock(rows: StreamRow[], block: HistoryBlock): void {
  if (block.type === "tool_call") {
    const args = callArguments(block)
    pushToolCall(rows, {
      name: block.name ?? "tool",
      ...(args !== undefined ? { arguments: args } : {}),
      ...(block.callId !== undefined ? { callId: block.callId } : {}),
    })
    return
  }
  if (block.type === "tool_result") {
    pushToolResult(rows, {
      name: block.name ?? "tool",
      content: block.content ?? (block.isError ? "error" : "ok"),
      isError: block.isError === true,
      ...(block.callId !== undefined ? { callId: block.callId } : {}),
    })
    return
  }
  const row = rowFromHistoryBlock(block)
  if (row) rows.push(row)
}

/**
 * Convenience: map an already-typed block list (e.g. from turns-to-blocks).
 */
export function rowsFromHistoryBlocks(
  blocks: readonly HistoryBlock[],
): StreamRow[] {
  const rows: StreamRow[] = []
  for (const block of blocks) {
    pushHistoryBlock(rows, block)
  }
  return rows
}
