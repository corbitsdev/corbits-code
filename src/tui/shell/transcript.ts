/**
 * Transcript rows: append/replace/retext, windowed repaint, spacer, row renderable builders.
 */
import {
  BoxRenderable,
  MarkdownRenderable,
  TextRenderable,
  TextTableRenderable,
  StyledText,
  type BaseRenderable,
  type CliRenderer,
} from "@opentui/core";
import { stringWidth } from "../view/height.js";
import { viewToTableContent, type McpStructuredView } from "../mcp-view.js";
import {
  armLinkLine,
  buildLinkLine,
  findLinks,
  paintLinkLine,
  splitLinkSpans,
} from "../url-links.js";
import {
  splitAtSettledHeading,
  withholdIncompleteHeading,
} from "../markdown-parser.js";
import { diffLineChunks, retextStyledKindRow } from "./row-retext.js";
import {
  blockLabel,
  EXPAND_KEY,
  expandedRowLines,
  splitTrailingArrow,
  isMarkdownRow,
  isSentenceRow,
  MAIN_AGENT,
  paintStreamRow,
  rowGroupGap,
  streamRowGutter,
  toolRowLines,
  toolSentenceLines,
  transcriptSyntaxStyle,
  type PaintedStreamLine,
  type RowLayout,
  type StreamRow,
  type StyledBodyLine,
} from "../stream.js";

import { type AppShell } from "./internals.js";

/**
 * Surface every row is laid out against: the transcript's own column budget
 * (rows right-align and wrap themselves) and whether writers need naming.
 * The scroll bars are hidden, so the transcript owns the whole content zone.
 */
export function transcriptRowLayout(shell: AppShell): RowLayout {
  return {
    width: Math.max(1, shell.layout.contentWidth),
    multiAgent: shell.agentVoices.size > 1,
  };
}

/**
 * Record a row's writer. Returns true when the transcript has just gained a
 * second voice — every earlier row now needs the label it was painted without.
 */
export function noteAgentVoice(shell: AppShell, row: StreamRow): boolean {
  if (row.role === "user") return false;
  const before = shell.agentVoices.size;
  shell.agentVoices.add(row.agent ?? MAIN_AGENT);
  return before === 1 && shell.agentVoices.size === 2;
}

/** Row immediately before `index` in the log, or undefined at the start. */
function rowBefore(shell: AppShell, index: number): StreamRow | undefined {
  return index > 0 ? shell.streamLog[index - 1] : undefined;
}

/** Blank rows the row at `index` claims above itself. */
export function gapBefore(shell: AppShell, index: number): number {
  const row = shell.streamLog[index];
  if (row === undefined) return 0;
  return rowGroupGap(rowBefore(shell, index), row);
}

/**
 * Writer label the row at `index` carries above it, or null mid-block.
 * A block is exactly a gap-free run from one writer, so this tracks
 * `gapBefore` rather than keeping its own notion of block boundaries.
 */
export function labelBefore(shell: AppShell, index: number): string | null {
  const row = shell.streamLog[index];
  if (row === undefined) return null;
  return blockLabel(rowBefore(shell, index), row, transcriptRowLayout(shell));
}

/** Row count of the log `appendStreamRow` currently targets (parent or observe). */
export function streamRowCount(shell: AppShell): number {
  return shell.observe !== null && shell.parentStreamLog !== null
    ? shell.parentStreamLog.length
    : shell.streamLogBase + shell.streamLog.length;
}

/**
 * Row at absolute `index` on the log `appendStreamRow` currently targets. A
 * tool result rewrites the call row it answers rather than appending its
 * own, and needs to read that row back to fold into it.
 *
 * `index` is absolute (see `streamLogBase`); a row already evicted by the
 * retention cap reads back as undefined, same as one past the end.
 */
export function streamRowAt(
  shell: AppShell,
  index: number,
): StreamRow | undefined {
  if (shell.observe !== null && shell.parentStreamLog !== null) {
    const local = index - (shell.parentStreamLogBase ?? 0);
    return local >= 0 && local < shell.parentStreamLog.length
      ? shell.parentStreamLog[local]
      : undefined;
  }
  const local = index - shell.streamLogBase;
  return local >= 0 && local < shell.streamLog.length
    ? shell.streamLog[local]
    : undefined;
}

/**
 * Identifies a transcript child as the eviction notice rather than a row.
 * Identity, not position or state, is the source of truth: `streamLogBase`
 * flips to nonzero the instant a trim happens, one step before the notice
 * node itself exists in the paint tree, so deriving "is there a marker"
 * from state would misalign row indices for exactly that transitional call.
 */
export const evictionMarkers = new WeakSet<BaseRenderable>();

/**
 * Row-index code paths (below, and the two windowed-rebuild callers) treat
 * `getChildren()` as a 1:1 array with `streamLog`. The leading bottom-anchor
 * spacer (see `transcriptSpacers`) and, once retention has evicted anything,
 * the eviction notice above the oldest retained row both break that — every
 * consumer that needs the row-only view goes through here rather than the
 * raw call.
 */
export function transcriptRowChildren(
  shell: AppShell,
): readonly BaseRenderable[] {
  const children = shell.transcript.getChildren().slice(1);
  const first = children[0];
  return first != null && evictionMarkers.has(first)
    ? children.slice(1)
    : children;
}

/** The eviction-notice node, if the retention cap has dropped anything. */
export function transcriptMarker(shell: AppShell): BaseRenderable | undefined {
  const children = shell.transcript.getChildren().slice(1);
  const first = children[0];
  return first != null && evictionMarkers.has(first) ? first : undefined;
}

/** Raw child-list offset before the first row: the spacer, plus the notice if present. */
export function transcriptRowOffset(shell: AppShell): number {
  return transcriptMarker(shell) === undefined ? 1 : 2;
}

/**
 * Rewrite a row's body on its existing paint node.
 *
 * Every row kind retextes in place — streaming markdown keeps the parser's
 * block state, and the styled kinds (diff, tool sentence, expansion,
 * structured) rewrite their line and table content. Returns false when the
 * node shape does not match the row (a label or arrow appearing, a line-count
 * change) and the caller must rebuild it.
 */
export function retextStreamRow(
  shell: AppShell,
  node: BaseRenderable,
  row: StreamRow,
  label: string | null,
): boolean {
  const layout = transcriptRowLayout(shell);
  if (label !== null) {
    if (!(node instanceof BoxRenderable)) return false;
    const [headerNode, innerNode] = node.getChildren();
    if (!(headerNode instanceof TextRenderable) || innerNode === undefined)
      return false;
    if (!retextStreamRowBody(innerNode, row, layout)) return false;
    headerNode.content = label;
    return true;
  }
  return retextStreamRowBody(node, row, layout);
}

/** The shape-matching rewrite shared by labelled and unlabelled rows. */
function retextStreamRowBody(
  node: BaseRenderable,
  row: StreamRow,
  layout: RowLayout,
): boolean {
  if (retextStyledKindRow(node, row, layout)) return true;
  if (
    row.diff !== undefined ||
    row.structured !== undefined ||
    isSentenceRow(row)
  )
    return false;
  if (node instanceof TextRenderable) {
    if (isMarkdownRow(row)) return false;
    paintPlainRowNode(node, paintStreamRow(row, layout));
    return true;
  }

  if (!(node instanceof BoxRenderable) || !isMarkdownRow(row)) return false;
  const [gutterNode, bodyNode] = node.getChildren();
  if (!(gutterNode instanceof TextRenderable)) return false;
  const gutter = streamRowGutter(row, layout);
  gutterNode.content = gutter.content;
  gutterNode.width = stringWidth(gutter.content);
  const width = markdownBodyColumns(gutter, layout);
  const content = markdownContent(row);
  const split = splitAtSettledHeading(content);

  // No settled heading behind the tail: a lone renderer, same as an unsplit
  // body. A shape change (a heading just closed, or one just left the window
  // a full rebuild trimmed) falls through to the caller's rebuild.
  if (split === null) {
    if (!(bodyNode instanceof MarkdownRenderable)) return false;
    bodyNode.width = width;
    bodyNode.content = content;
    bodyNode.streaming = row.streaming === true;
    return true;
  }

  if (!(bodyNode instanceof BoxRenderable)) return false;
  const [frozenNode, liveNode] = bodyNode.getChildren();
  if (
    !(frozenNode instanceof MarkdownRenderable) ||
    !(liveNode instanceof MarkdownRenderable)
  ) {
    return false;
  }
  bodyNode.width = width;
  frozenNode.width = width;
  frozenNode.content = split.frozen;
  liveNode.width = width;
  liveNode.content = split.live;
  liveNode.streaming = row.streaming === true;
  liveNode.marginTop = split.gapRows;
  return true;
}

/**
 * Prefix column beside a body the renderer owns. Width is pinned to the painted
 * columns so an empty gutter — a lone agent's own prose — costs none, and the
 * answer starts on the transcript's first column.
 */
function gutterNode(
  ctx: CliRenderer,
  gutter: PaintedStreamLine,
): TextRenderable {
  return new TextRenderable(ctx, {
    content: gutter.content,
    fg: gutter.fg,
    flexShrink: 0,
    width: stringWidth(gutter.content),
  });
}

/**
 * Columns a markdown body may paint into: the transcript budget less the
 * row's own prefix. Pinned rather than left to `flexGrow`, which reports the
 * body's intrinsic width to yoga and lets a wide table paint past the edge.
 */
function markdownBodyColumns(
  gutter: PaintedStreamLine,
  layout: RowLayout,
): number {
  return Math.max(1, layout.width - stringWidth(gutter.content));
}

/**
 * Markdown tables shrink to the row's column budget rather than overflowing:
 * columns are fitted proportionally and cells wrap on word boundaries. A table
 * still too wide for its narrowest fit is clipped by the body's pinned width,
 * which keeps it inside the transcript instead of painting over the chrome.
 */
const TRANSCRIPT_TABLE_OPTIONS = {
  wrapMode: "word",
  columnFitter: "proportional",
} as const;

function markdownContent(row: StreamRow): string {
  if (row.streaming !== true) return row.text;
  return withholdIncompleteHeading(row.text);
}

/**
 * Build the row-shaped paint node: a MarkdownRenderable body next to a plain
 * gutter for markdown-bearing rows (assistant replies), a TextTableRenderable
 * for structured rows (MCP results), a coloured diff body for edit-tool rows,
 * and literal text for everything else.
 */
export function buildRowNode(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  onToggle?: () => void,
): TextRenderable | BoxRenderable {
  if (isSentenceRow(row)) {
    // The sentence is one line: it is cut to the columns beside the marker
    // rather than wrapped, so a long URL or query cannot double the row.
    const columns = Math.max(
      1,
      layout.width - stringWidth(streamRowGutter(row, layout).content),
    );
    if (row.structured !== undefined) {
      // The table is what the sentence hides; collapsed, the sentence is the row.
      return row.expanded === true
        ? createStructuredRowRenderable(
            ctx,
            row,
            layout,
            row.structured,
            toolSentenceLines(row, columns),
            onToggle,
          )
        : createStyledLinesRowRenderable(
            ctx,
            row,
            layout,
            toolSentenceLines(row, columns),
            onToggle,
          );
    }
    return createStyledLinesRowRenderable(
      ctx,
      row,
      layout,
      toolRowLines(row, columns),
      onToggle,
    );
  }

  if (row.diff !== undefined) {
    return createStyledLinesRowRenderable(ctx, row, layout, row.diff.lines);
  }

  const expanded = expandedRowLines(row, layout);
  if (expanded !== null) {
    return createStyledLinesRowRenderable(ctx, row, layout, expanded);
  }

  if (row.structured !== undefined) {
    return createStructuredRowRenderable(ctx, row, layout, row.structured);
  }

  if (!isMarkdownRow(row)) {
    return buildPlainRowNode(ctx, paintStreamRow(row, layout));
  }

  const gutter = streamRowGutter(row, layout);
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  });
  wrapper.add(gutterNode(ctx, gutter));
  wrapper.add(createMarkdownBody(ctx, row, gutter, layout));
  return wrapper;
}

/** Shared construction options for a transcript markdown body's renderer. */
function markdownBodyOptions(gutter: PaintedStreamLine, width: number) {
  return {
    syntaxStyle: transcriptSyntaxStyle(),
    fg: gutter.fg,
    width,
    flexShrink: 0,
    tableOptions: TRANSCRIPT_TABLE_OPTIONS,
  } as const;
}

/**
 * A literal-text row's paint node: always a single text node, as before. Rows
 * holding URLs paint styled text (URL spans carry OSC-8 metadata) and arm as
 * Ctrl+click targets; URL-free rows paint the plain string they always have.
 */
function buildPlainRowNode(
  ctx: CliRenderer,
  painted: PaintedStreamLine,
): TextRenderable {
  const node = new TextRenderable(ctx, {
    content: painted.content,
    fg: painted.fg,
  });
  paintPlainRowNode(node, painted);
  return node;
}

/**
 * Rewrite a plain row's text on its existing node. The node never changes
 * shape, so a URL appearing or disappearing repaints in place instead of
 * forcing a rebuild.
 */
function paintPlainRowNode(
  node: TextRenderable,
  painted: PaintedStreamLine,
): void {
  const lines = painted.content.split("\n");
  if (!lines.some((line) => findLinks(line).length > 0)) {
    node.content = painted.content;
    node.fg = painted.fg;
    // Route through the armer so a retext that drops the last URL disarms
    // the handlers a previous arming installed (armLinkLine clears them).
    armLinkLine(node, []);
    return;
  }
  paintLinkLine(
    node,
    lines.map((line) => splitLinkSpans([{ text: line, fg: painted.fg }])),
  );
}

/**
 * A markdown row's body. Most rows have no settled heading yet (no heading at
 * all, or the only one is still the open tail), and paint through a single
 * renderer, same as before this fix existed. Once a heading closes, the body
 * becomes a settled `frozen` renderer — everything through that heading,
 * never streaming, never handed new content while the tail keeps growing, so
 * it is never asked to re-highlight once written — stacked above the still
 * `live` one, which carries the row's own streaming flag. Both halves use the
 * library's default block mode, so paragraphs, lists and tables inside either
 * one lay out exactly as a single unsplit body would.
 */
function createMarkdownBody(
  ctx: CliRenderer,
  row: StreamRow,
  gutter: PaintedStreamLine,
  layout: RowLayout,
): MarkdownRenderable | BoxRenderable {
  const width = markdownBodyColumns(gutter, layout);
  const content = markdownContent(row);
  const split = splitAtSettledHeading(content);
  if (split === null) {
    // Native incremental block stability: only the trailing block is unstable.
    return new MarkdownRenderable(ctx, {
      ...markdownBodyOptions(gutter, width),
      content,
      streaming: row.streaming === true,
    });
  }
  const column = new BoxRenderable(ctx, { flexDirection: "column", width });
  column.add(
    new MarkdownRenderable(ctx, {
      ...markdownBodyOptions(gutter, width),
      content: split.frozen,
      streaming: false,
    }),
  );
  column.add(
    new MarkdownRenderable(ctx, {
      ...markdownBodyOptions(gutter, width),
      content: split.live,
      streaming: row.streaming === true,
      marginTop: split.gapRows,
    }),
  );
  return column;
}

/**
 * Gutter + one text line per body row, for bodies that arrive already coloured
 * and already laid out (a diff, an expanded tool call's structured arguments).
 * Each line paints inside the body column, so a wrapped line lands under the
 * body rather than in the shell's gutter.
 */
function createStyledLinesRowRenderable(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  lines: readonly StyledBodyLine[],
  onToggle?: () => void,
): BoxRenderable {
  const gutter = streamRowGutter(row, layout);
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  });
  wrapper.add(gutterNode(ctx, gutter));
  const body = new BoxRenderable(ctx, {
    flexDirection: "column",
    flexGrow: 1,
  });
  for (const line of lines) {
    body.add(bodyLineNode(ctx, line, onToggle));
  }
  wrapper.add(body);
  return wrapper;
}

/**
 * One painted body line. A line ending in an expand arrow is split so the
 * arrow is its own renderable and can answer a click; a line holding URLs
 * paints styled text and arms as a Ctrl+click target (see url-links.ts);
 * every other line is a single text node, as before.
 */
function bodyLineNode(
  ctx: CliRenderer,
  line: StyledBodyLine,
  onToggle?: () => void,
): TextRenderable | BoxRenderable {
  const split = onToggle === undefined ? null : splitTrailingArrow(line);
  if (split === null || onToggle === undefined) {
    return buildLinkLine(ctx, splitLinkSpans(line));
  }
  const wrapper = new BoxRenderable(ctx, { flexDirection: "row", flexGrow: 1 });
  const body = buildLinkLine(ctx, splitLinkSpans(split.body));
  body.flexShrink = 0;
  wrapper.add(body);
  wrapper.add(
    new TextRenderable(ctx, {
      content: new StyledText(diffLineChunks([split.arrow])),
      flexShrink: 0,
      width: stringWidth(split.arrow.text),
      onMouseDown: (event) => {
        // The transcript scroll box drags on the same press; a toggle is not a
        // scroll gesture, so the arrow keeps the event.
        event.stopPropagation();
        onToggle();
      },
    }),
  );
  return wrapper;
}

/**
 * Gutter + native table body for a structured (MCP result) row, under the head
 * lines the row collapses to. The head and the table share one body column so
 * the table stays inside the shell's gutter.
 */
function createStructuredRowRenderable(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  view: McpStructuredView,
  head: readonly StyledBodyLine[] = [],
  onToggle?: () => void,
): BoxRenderable {
  const gutter = streamRowGutter(row, layout);
  const wrapper = new BoxRenderable(ctx, {
    flexDirection: "row",
    width: "100%",
  });
  wrapper.add(gutterNode(ctx, gutter));
  const body = new BoxRenderable(ctx, { flexDirection: "column", flexGrow: 1 });
  for (const line of head) {
    body.add(bodyLineNode(ctx, line, onToggle));
  }
  body.add(
    new TextTableRenderable(ctx, {
      content: viewToTableContent(view),
      columnWidthMode: "content",
      columnGap: 2,
      showBorders: false,
      wrapMode: "none",
      flexGrow: 1,
    }),
  );
  wrapper.add(body);
  return wrapper;
}

/**
 * Bare key the modal overlay claims for its expand/collapse hook. Deliberately
 * not in SHELL_SHORTCUTS: it is live only while an overlay that supplied
 * `onToggleExpand` is open, so it never shadows a prompt binding.
 */
export const OVERLAY_EXPAND_KEY = EXPAND_KEY;
