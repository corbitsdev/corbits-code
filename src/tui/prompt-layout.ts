import { wrapLines } from "./view/height.js";

/** Inner text width inside the bordered prompt box (`> ` prefix included in layout). */
export function promptContentWidth(columns: number): number {
  return Math.max(8, columns - 8);
}

/** Logical visual rows inside the prompt (wrapped), before the 40vh cap. */
export function countPromptVisualLines(value: string, columns: number): number {
  const width = promptContentWidth(columns);
  let count = 0;
  for (const logical of value.split("\n")) {
    const wrapped = wrapLines(logical, width);
    count += wrapped.length > 0 ? wrapped.length : 1;
  }
  return Math.max(1, count);
}

export type PromptWindow = {
  windowStart: number;
  windowEnd: number;
  atTopEdge: boolean;
  atBottomEdge: boolean;
};

/** Mirrors ChatInput's scroll window so layout reserves the same row count. */
export function promptScrollWindow(
  value: string,
  columns: number,
  terminalRows: number,
  cursor = value.length,
): PromptWindow {
  const width = promptContentWidth(columns);
  const visualLines: Array<{ text: string; logicalStart: number }> = [];
  let logicalStart = 0;
  for (const logical of value.split("\n")) {
    const wrapped = wrapLines(logical, width);
    const rowsForLine = wrapped.length > 0 ? wrapped : [""];
    let offset = 0;
    for (const row of rowsForLine) {
      visualLines.push({ text: row, logicalStart: logicalStart + offset });
      offset += row.length;
    }
    logicalStart += logical.length + 1;
  }
  const lineCount = visualLines.length;
  let cursorLine = Math.max(0, lineCount - 1);
  for (let i = 0; i < visualLines.length; i++) {
    const start = visualLines[i]!.logicalStart;
    const end = start + visualLines[i]!.text.length;
    if (cursor >= start && cursor <= end) {
      cursorLine = i;
      break;
    }
  }
  const maxBoxRows = Math.max(3, Math.floor(terminalRows * 0.4));
  let windowStart = 0;
  let windowEnd = lineCount;
  if (lineCount > maxBoxRows) {
    windowStart = Math.max(0, cursorLine - maxBoxRows + 1);
    windowEnd = windowStart + maxBoxRows;
    if (windowEnd > lineCount) {
      windowEnd = lineCount;
      windowStart = windowEnd - maxBoxRows;
    }
  }
  return {
    windowStart,
    windowEnd,
    atTopEdge: windowStart > 0,
    atBottomEdge: windowEnd < lineCount,
  };
}

/** Rows rendered inside the bordered box (content + optional scroll hints). */
export function promptInnerRowCount(value: string, columns: number, terminalRows: number): number {
  const { windowStart, windowEnd, atTopEdge, atBottomEdge } = promptScrollWindow(value, columns, terminalRows);
  let inner = Math.max(1, windowEnd - windowStart);
  if (atTopEdge) inner += 1;
  if (atBottomEdge) inner += 1;
  return inner;
}

// CHROME_ROWS reserves a 3-row prompt box: top border + one content line + bottom border.
export const PROMPT_BOX_BASE_INNER_ROWS = 1;

/** Extra rows to subtract from the transcript beyond fixed CHROME_ROWS. */
export function extraPromptChromeRows(value: string, columns: number, terminalRows: number): number {
  return Math.max(0, promptInnerRowCount(value, columns, terminalRows) - PROMPT_BOX_BASE_INNER_ROWS);
}