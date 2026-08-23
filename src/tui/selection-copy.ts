/**
 * Auto-copy finished OpenTUI mouse selections to the system clipboard.
 *
 * OpenTUI emits CliRenderEvents.SELECTION once on mouse-up
 * (`finishSelection`). Mid-drag updates do not emit that event, so one
 * handler is copy-on-release without per-pixel noise.
 */

import type { Selection } from "@opentui/core";
import { writeClipboard, type ClipboardPort } from "./copy-path.js";

/** Minimal deps so unit tests do not need a full AppShell. */
export interface SelectionCopyHost {
  readonly clipboard: ClipboardPort;
  readonly flash: (text: string) => void;
  readonly clearSelection: () => void;
}

/** Slice of OpenTUI Selection used by the copy path. */
export interface FinishedSelection {
  readonly isDragging: boolean;
  getSelectedText(): string;
}

/**
 * Copy a finished (non-dragging) selection. Returns true when a write was
 * attempted. Empty selections and still-dragging states are no-ops.
 *
 * Clears the highlight immediately so a slow or hung clipboard helper cannot
 * leave the selection stuck. Status flash waits for write settlement:
 * `Copied …` on success, `Copy failed` on throw/reject.
 */
export function copyFinishedSelection(
  host: SelectionCopyHost,
  selection: FinishedSelection | Selection,
): boolean {
  if (selection.isDragging) return false;
  const text = selection.getSelectedText();
  if (text.length === 0) return false;

  // Notice row is one line; always collapse whitespace so multi-line
  // drag-selects do not inject raw newlines into chrome.
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine;

  // Clear before the write settles — honesty only gates the flash message.
  host.clearSelection();
  writeClipboard(host.clipboard, text, {
    onSuccess: () => {
      host.flash(`Copied ${text.length} chars: ${preview}`);
    },
    onFailure: () => {
      host.flash("Copy failed");
    },
  });
  return true;
}
