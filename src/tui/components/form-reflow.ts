// Shared layout helpers for settings / agent forms on narrow terminals.

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
 */
export function fitTrailingText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  return `…${text.slice(-(maxWidth - 1))}`;
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
      current = segment.length > width ? fitTrailingText(segment, width) : segment;
      continue;
    }
    const candidate = `${current} · ${segment}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = segment.length > width ? fitTrailingText(segment, width) : segment;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
