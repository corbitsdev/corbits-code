/**
 * Auto-copy finished OpenTUI mouse selections to the system clipboard.
 *
 * OpenTUI emits CliRenderEvents.SELECTION once on mouse-up
 * (`finishSelection`). Mid-drag updates do not emit that event, so one
 * handler is copy-on-release without per-pixel noise.
 */

import type { Selection } from "@opentui/core"
import type { ClipboardPort } from "./copy-path.js"

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
 * Copy a finished (non-dragging) selection. Returns true when text was
 * written. Empty selections and still-dragging states are no-ops.
 */
export function copyFinishedSelection(
  host: SelectionCopyHost,
  selection: FinishedSelection | Selection,
): boolean {
  if (selection.isDragging) return false
  const text = selection.getSelectedText()
  if (text.length === 0) return false

  void host.clipboard.writeText(text)
  const preview =
    text.length > 48 ? `${text.slice(0, 45).replace(/\s+/g, " ")}…` : text
  host.flash(`Copied ${text.length} chars: ${preview}`)
  host.clearSelection()
  return true
}
