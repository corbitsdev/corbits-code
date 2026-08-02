import { useState } from "react";

// Terminals that don't report a size (or report one before the first resize
// event lands) fall back to a conservative row count so a modal still lays
// out something scrollable rather than assuming infinite height.
export const FALLBACK_TERMINAL_ROWS = 24;

function maxRowOffset(rowCount: number, visibleRows: number): number {
  return Math.max(0, rowCount - visibleRows);
}

export type ScrollWindow = {
  // Current top-of-viewport row, clamped to [0, maxOffset].
  offset: number;
  maxOffset: number;
  // Row counts above/below the visible window, for a "N more above/below"
  // scroll indicator.
  above: number;
  below: number;
  pageUp: () => void;
  pageDown: () => void;
};

// Top-pinned scroll state shared by the approval modals: a body opens showing
// its start, with PageUp/PageDown clamped to [0, rowCount - visibleRows].
// Both operator-modal and permission-modal had their own copy of this offset
// math and paging logic; this is the single place it's owned now.
export function useScrollWindow(rowCount: number, visibleRows: number): ScrollWindow {
  const maxOffset = maxRowOffset(rowCount, visibleRows);
  const [rawOffset, setOffset] = useState(0);
  const offset = Math.min(rawOffset, maxOffset);
  const above = offset;
  const below = Math.max(0, rowCount - offset - visibleRows);

  const pageUp = (): void => setOffset((o) => Math.max(0, o - visibleRows));
  const pageDown = (): void => setOffset((o) => Math.min(maxOffset, o + visibleRows));

  return { offset, maxOffset, above, below, pageUp, pageDown };
}
