// Shared layout helpers for settings / agent forms on narrow terminals.

import { stringWidth } from "../view/height.js";

/** Stack labels above values below this terminal width. */
export const STACK_FORM_COLUMNS = 56;

/** Outer chrome: marginX(1)*2 + paddingX (2 wide / 1 narrow)*2. */
export function formContentWidth(columns: number, narrow: boolean): number {
  const padX = narrow ? 1 : 2;
  return Math.max(12, columns - 2 - padX * 2);
}

/**
 * Caret sits at the end of append-only fields; keep the trailing slice so the
 * insertion point stays on-screen when the value is longer than the pane.
 * Budget is terminal columns (display width), not UTF-16 length — CJK and
 * emoji are two cells each.
 */
export function fitTrailingText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";

  // Walk code points from the end until the trailing slice fills maxWidth - 1
  // (one cell reserved for the leading ellipsis).
  const budget = maxWidth - 1;
  const units = Array.from(text);
  let used = 0;
  let start = units.length;
  for (let i = units.length - 1; i >= 0; i--) {
    const cw = stringWidth(units[i]!);
    if (used + cw > budget) break;
    used += cw;
    start = i;
  }
  return `…${units.slice(start).join("")}`;
}

/** Pack " · "-separated help segments into lines that fit the pane. */
export function wrapHelpSegments(segments: readonly string[], maxWidth: number): string[] {
  if (segments.length === 0) return [];
  const width = Math.max(8, maxWidth);
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (current.length === 0) {
      current = stringWidth(segment) > width ? fitTrailingText(segment, width) : segment;
      continue;
    }
    const candidate = `${current} · ${segment}`;
    if (stringWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = stringWidth(segment) > width ? fitTrailingText(segment, width) : segment;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
