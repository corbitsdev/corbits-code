/**
 * Keyboard copy path — message / tool / diff without mouse drag-select.
 * Binding: Alt+C (interaction contract).
 * Pure format + port; shell wires the chord and overlay picker.
 */

import { diffPlainText } from "./diff.js"
import type { StreamRow } from "./stream.js"

export type CopyKind = "message" | "tool" | "diff" | "system"

export type CopyPayload = {
  readonly kind: CopyKind
  readonly text: string
  /** Short status line for the transcript / flash. */
  readonly summary: string
}

/** One frozen selectable chunk for the copy overlay (Ink parity). */
export type CopyTarget = {
  readonly id: string
  readonly label: string
  readonly preview: string
  readonly text: string
}

export type ClipboardPort = {
  readonly writeText: (text: string) => void | Promise<void>
}

/**
 * Write to the clipboard, then run success/failure handlers.
 * Never throws: sync throws and promise rejections both hit onFailure.
 * Flash "Copied …" only from onSuccess so a failed write never lies.
 */
export function writeClipboard(
  port: ClipboardPort,
  text: string,
  handlers: {
    readonly onSuccess: () => void
    readonly onFailure?: () => void
  },
): void {
  const fail = () => {
    handlers.onFailure?.()
  }
  try {
    const result = port.writeText(text)
    if (
      result != null
      && typeof (result as PromiseLike<void>).then === "function"
    ) {
      void Promise.resolve(result).then(handlers.onSuccess, fail)
      return
    }
    handlers.onSuccess()
  } catch {
    fail()
  }
}

/** Recording port for headless tests. */
export function createRecordingClipboard(): ClipboardPort & {
  readonly writes: string[]
} {
  const writes: string[] = []
  return {
    writes,
    writeText: (text: string) => {
      writes.push(text)
    },
  }
}

function oneLine(text: string, max = 56): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * Infer copy kind from a stream row.
 * Rows carrying a rendered edit diff win; otherwise assistant/tool rows whose
 * text looks like a unified diff.
 */
export function classifyCopy(row: StreamRow): CopyKind {
  if (row.diff !== undefined) return "diff"
  if (row.role === "tool") return "tool"
  if (row.role === "system") return "system"
  const body = row.text
  if (
    body.includes("\n@@ ") ||
    body.startsWith("diff --git") ||
    (/^[-+]{3} [ab]\//m.test(body) && body.includes("\n@@"))
  ) {
    return "diff"
  }
  return "message"
}

/** Human label for a stream row in the copy picker. */
export function copyRowLabel(row: StreamRow): string {
  const kind = classifyCopy(row)
  if (kind === "tool") {
    return row.meta && row.meta.length > 0 ? `${row.meta} output` : "tool output"
  }
  if (kind === "diff") return "edit diff"
  if (row.role === "user") return "your message"
  if (kind === "system") return "system"
  return "assistant message"
}

/** Format clipboard text for a row (no ANSI; plain for paste). */
export function formatCopyText(row: StreamRow): CopyPayload {
  const kind = classifyCopy(row)
  const meta = row.meta && row.meta.length > 0 ? `[${row.meta}] ` : ""
  let text: string
  switch (kind) {
    case "tool":
      text = meta + row.text
      break
    case "diff":
      // Rendered edit rows copy the diff itself, not the raw JSON arguments.
      text = row.diff !== undefined ? diffPlainText(row.diff) : row.text
      break
    case "system":
      text = row.text
      break
    default:
      text = row.text
  }
  const preview =
    text.length > 48 ? `${text.slice(0, 45).replace(/\s+/g, " ")}…` : text
  return {
    kind,
    text,
    summary: `copied ${kind} (${text.length} chars): ${preview}`,
  }
}

/**
 * Build frozen copy targets from a stream log (oldest first).
 * Skips system rows — copy feedback and chrome noise are not selectable.
 */
export function buildCopyTargets(log: readonly StreamRow[]): CopyTarget[] {
  const targets: CopyTarget[] = []
  for (let i = 0; i < log.length; i++) {
    const row = log[i]
    if (!row || row.role === "system") continue
    const payload = formatCopyText(row)
    targets.push({
      id: `row-${i}`,
      label: copyRowLabel(row),
      preview: oneLine(payload.text),
      text: payload.text,
    })
  }
  return targets
}

/** Portable markdown for "copy everything" (stream rows, not Ink ContentBlock). */
export function streamLogMarkdown(targets: readonly CopyTarget[]): string {
  return targets.map((t) => `## ${t.label}\n\n${t.text}`).join("\n\n")
}

/**
 * Copy the active (or last) stream row via the clipboard port.
 * Returns the payload, or null when there is nothing to copy.
 */
export function copyStreamRow(
  row: StreamRow | undefined | null,
  port: ClipboardPort,
): CopyPayload | null {
  if (!row) return null
  const payload = formatCopyText(row)
  void port.writeText(payload.text)
  return payload
}

/** Pick the row to copy: explicit index, else last non-system, else last. */
export function pickCopyRow(
  log: readonly StreamRow[],
  activeIndex?: number,
): StreamRow | null {
  if (log.length === 0) return null
  if (activeIndex !== undefined) {
    const i = Math.max(0, Math.min(log.length - 1, Math.floor(activeIndex)))
    return log[i] ?? null
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const row = log[i]
    if (row && row.role !== "system") return row
  }
  return log[log.length - 1] ?? null
}
