/**
 * In-place retext for the styled-line and structured row kinds (diff, tool
 * sentence, expansion, MCP structured): these rewrite their paint nodes'
 * content instead of being destroyed and rebuilt on every update. A shape
 * change (line count, arrow presence) still returns false so the caller
 * rebuilds — only how updates apply changes, never what renders.
 */
import {
  BoxRenderable,
  TextRenderable,
  TextTableRenderable,
  bold as boldChunk,
  fg as fgChunk,
  type BaseRenderable,
  type TextChunk,
} from "@opentui/core";
import { stringWidth } from "../view/height.js";
import { viewToTableContent, type McpStructuredView } from "../mcp-view.js";
import { splitLinkSpans, paintLinkLine } from "../url-links.js";
import {
  splitTrailingArrow,
  expandedRowLines,
  isSentenceRow,
  streamRowGutter,
  toolRowLines,
  toolSentenceLines,
  type PaintedStreamLine,
  type RowLayout,
  type StreamRow,
  type StyledBodyLine,
} from "../stream.js";

/** Map one styled body line's segments to native text chunks. */
export function diffLineChunks(line: StyledBodyLine): TextChunk[] {
  return line.map((segment) => {
    const chunk = fgChunk(segment.fg)(segment.text);
    return segment.bold === true ? boldChunk(chunk) : chunk;
  });
}

/** Columns a sentence row's single line paints into, beside its gutter. */
function sentenceColumns(row: StreamRow, layout: RowLayout): number {
  return Math.max(
    1,
    layout.width - stringWidth(streamRowGutter(row, layout).content),
  );
}

/**
 * Retext a styled-lines or structured row kind on its existing node, mirroring
 * `buildRowNode`'s kind dispatch. Returns false when the row is not one of
 * these kinds or the node shape no longer matches, leaving the caller to
 * rebuild.
 */
export function retextStyledKindRow(
  node: BaseRenderable,
  row: StreamRow,
  layout: RowLayout,
): boolean {
  if (isSentenceRow(row)) {
    const columns = sentenceColumns(row, layout);
    if (row.structured !== undefined) {
      return row.expanded === true
        ? retextStructuredRow(
            node,
            row,
            layout,
            toolSentenceLines(row, columns),
            row.structured,
          )
        : retextStyledLinesRow(
            node,
            row,
            layout,
            toolSentenceLines(row, columns),
          );
    }
    return retextStyledLinesRow(node, row, layout, toolRowLines(row, columns));
  }
  if (row.diff !== undefined)
    return retextStyledLinesRow(node, row, layout, row.diff.lines);
  const expanded = expandedRowLines(row, layout);
  if (expanded !== null)
    return retextStyledLinesRow(node, row, layout, expanded);
  if (row.structured !== undefined) {
    return retextStructuredRow(node, row, layout, [], row.structured);
  }
  return false;
}

function retextGutter(node: TextRenderable, gutter: PaintedStreamLine): void {
  node.content = gutter.content;
  node.fg = gutter.fg;
  node.width = stringWidth(gutter.content);
}

function retextStyledLinesRow(
  node: BaseRenderable,
  row: StreamRow,
  layout: RowLayout,
  lines: readonly StyledBodyLine[],
): boolean {
  if (!(node instanceof BoxRenderable)) return false;
  const [gutterNode, bodyNode] = node.getChildren();
  if (
    !(gutterNode instanceof TextRenderable) ||
    !(bodyNode instanceof BoxRenderable)
  )
    return false;
  const lineNodes = bodyNode.getChildren();
  // A different line count is a different shape — the caller rebuilds.
  if (lineNodes.length !== lines.length) return false;
  for (const [i, line] of lines.entries()) {
    if (!retextBodyLine(lineNodes[i], line)) return false;
  }
  retextGutter(gutterNode, streamRowGutter(row, layout));
  return true;
}

/** One body line in place; an arrow line retextes only its body segment. */
function retextBodyLine(
  node: BaseRenderable | undefined,
  line: StyledBodyLine,
): boolean {
  const split = splitTrailingArrow(line);
  if (node instanceof TextRenderable) {
    if (split !== null) return false;
    // A URL appearing or disappearing repaints on the same node; re-arming
    // refreshes the hit ranges, so hover never resolves against stale text.
    paintLinkLine(node, [splitLinkSpans(line)]);
    return true;
  }
  if (!(node instanceof BoxRenderable) || split === null) return false;
  const [bodyNode] = node.getChildren();
  if (!(bodyNode instanceof TextRenderable)) return false;
  paintLinkLine(bodyNode, [splitLinkSpans(split.body)]);
  return true;
}

function retextStructuredRow(
  node: BaseRenderable,
  row: StreamRow,
  layout: RowLayout,
  head: readonly StyledBodyLine[],
  view: McpStructuredView,
): boolean {
  if (!(node instanceof BoxRenderable)) return false;
  const [gutterNode, bodyNode] = node.getChildren();
  if (
    !(gutterNode instanceof TextRenderable) ||
    !(bodyNode instanceof BoxRenderable)
  )
    return false;
  const children = bodyNode.getChildren();
  if (children.length !== head.length + 1) return false;
  const tableNode = children[head.length];
  if (!(tableNode instanceof TextTableRenderable)) return false;
  for (const [i, line] of head.entries()) {
    if (!retextBodyLine(children[i], line)) return false;
  }
  retextGutter(gutterNode, streamRowGutter(row, layout));
  // TextTableRenderable diffs cells in place on content assignment.
  tableNode.content = viewToTableContent(view);
  return true;
}
