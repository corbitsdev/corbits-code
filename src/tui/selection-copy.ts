/**
 * Auto-copy finished OpenTUI mouse selections to the system clipboard.
 *
 * OpenTUI emits CliRenderEvents.SELECTION once on mouse-up
 * (`finishSelection`). Mid-drag updates do not emit that event, so one
 * handler is copy-on-release without per-pixel noise.
 */

import type { Selection } from "@opentui/core"
import { writeClipboard, type ClipboardPort } from "./copy-path.js"

/** Minimal deps so unit tests do not need a full AppShell. */
export type SelectionCopyHost = {
  readonly clipboard: ClipboardPort
  readonly flash: (text: string) => void
  readonly clearSelection: () => void
}

/** Slice of OpenTUI Selection used by the copy path. */
export type FinishedSelection = {
  readonly isDragging: boolean
  getSelectedText(): string
}

/**
 * Copy a finished (non-dragging) selection. Returns true when a write was
 * attempted. Empty selections and still-dragging states are no-ops.
 * Status flash only runs after a successful clipboard write.
 */
export function copyFinishedSelection(
  host: SelectionCopyHost,
  selection: FinishedSelection | Selection,
): boolean {
  if (selection.isDragging) return false
  const text = selection.getSelectedText()
  if (text.length === 0) return false

  // Notice row is one line; always collapse whitespace so multi-line
  // drag-selects do not inject raw newlines into chrome.
  const oneLine = text.replace(/\s+/g, " ").trim()
  const preview =
    oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine

  writeClipboard(host.clipboard, text, {
    onSuccess: () => {
      host.flash(`Copied ${text.length} chars: ${preview}`)
      host.clearSelection()
    },
    onFailure: () => {
      host.flash("Copy failed")
      host.clearSelection()
    },
  })
  return true
}
