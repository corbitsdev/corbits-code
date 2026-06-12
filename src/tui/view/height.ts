import { type ViewNode, VIEW_TABLE_MAX_ROWS } from "./spec.js";

// Painted height of a node at a given pane width, used by the event log's
// line-based scroll model (estimateRows). Must match what the registry renders:
// text/heading wrap (and may overcount, which is the safe direction); every other
// node renders one truncated line per item, so its height is an exact count.

const LINE_PADDING = 2;

// Count the rows a line occupies under word wrapping, matching Ink's <Text
// wrap="wrap">. A naive ceil(len/width) UNDERCOUNTS space-heavy text (words don't
// split across the boundary), and undercounting is the dangerous direction for the
// scroll model — it lets the log paint more rows than the viewport. Simulate the
// greedy wrap instead: words go on the current line until they don't fit; a word
// longer than the width breaks across lines by character.
function wrapLineCount(line: string, width: number): number {
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return 1;
  let lines = 1;
  let col = 0;
  const placeLongWord = (len: number): void => {
    lines += Math.floor(len / width);
    col = len % width;
  };
  for (const word of words) {
    if (col === 0) {
      if (word.length <= width) col = word.length;
      else placeLongWord(word.length);
    } else if (col + 1 + word.length <= width) {
      col += 1 + word.length;
    } else {
      lines += 1;
      if (word.length <= width) col = word.length;
      else placeLongWord(word.length);
    }
  }
  return Math.max(1, lines);
}

export function wrapCount(text: string, width: number): number {
  const w = Math.max(1, width);
  return text.split("\n").reduce((n, line) => n + wrapLineCount(line, w), 0);
}

export function viewHeight(node: ViewNode, columns: number): number {
  const width = Math.max(8, columns - LINE_PADDING);
  switch (node.type) {
    case "divider":
    case "badge":
    case "progress":
      return 1;
    case "text":
    case "heading":
      return wrapCount(node.value, width);
    case "keyValue":
      return Math.max(1, node.pairs.length);
    case "list":
      return Math.max(1, node.items.length);
    case "table": {
      const shown = Math.min(node.rows.length, VIEW_TABLE_MAX_ROWS);
      return 1 + shown + (node.rows.length > shown ? 1 : 0);
    }
    case "card": {
      const title = node.title !== undefined ? 1 : 0;
      const subtitle = node.subtitle !== undefined ? 1 : 0;
      const badges = node.badges !== undefined && node.badges.length > 0 ? 1 : 0;
      return Math.max(1, title + subtitle + node.fields.length + badges);
    }
    case "stack": {
      const sum = node.children.reduce((n, c) => n + viewHeight(c, columns), 0);
      const gaps = (node.gap ?? 0) > 0 && node.children.length > 1 ? node.children.length - 1 : 0;
      return Math.max(1, sum + gaps);
    }
  }
}
