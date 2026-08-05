/**
 * Transcript stream row model — product skin styling for fake / real streams.
 * Pure format helpers; shell paints via TextRenderable.
 */

export type StreamRole = "user" | "assistant" | "tool" | "system"

export type StreamRow = {
  readonly role: StreamRole
  readonly text: string
  /** Optional secondary label (tool name, timestamp, etc.). */
  readonly meta?: string
}

export type PaintedStreamLine = {
  readonly content: string
  readonly fg: string
}

const ROLE_FG: Record<StreamRole, string> = {
  user: "#bb9af7",
  assistant: "#9ece6a",
  tool: "#7dcfff",
  system: "#565f89",
}

const ROLE_LABEL: Record<StreamRole, string> = {
  user: "you",
  assistant: "agent",
  tool: "tool",
  system: "sys",
}

/** Format a stream row for the transcript (prefix + body, role color). */
export function paintStreamRow(row: StreamRow): PaintedStreamLine {
  const label = ROLE_LABEL[row.role]
  const meta = row.meta && row.meta.length > 0 ? ` ${row.meta}` : ""
  const body = row.text
  return {
    content: ` ${label}${meta}  ${body}`,
    fg: ROLE_FG[row.role],
  }
}

/** Hint line under the prompt (locked product bindings). */
export const PROMPT_HINT =
  "Enter queue · Alt+Enter steer · Ctrl+C stop" as const

/** Header chrome for product-skin demo sessions. */
export function sessionHeaderTitle(
  title: string,
  run: "idle" | "busy",
): string {
  const tag = run === "busy" ? "BUSY" : "IDLE"
  return `${title} · ${tag}`
}
