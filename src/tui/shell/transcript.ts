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
import { armLinkLine, buildLinkLine, paintLinkLine } from "../url-links.js";
import { findLinks, splitLinkSpans } from "../link-spans.js";
import { splitWrappedLinkSpans } from "../link-wrap.js";
import {
  nextStreamMarkdownState,
  splitAtSettledBlock,
  withholdIncompleteHeading,
  type StreamMarkdownSnapshot,
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
  plainRowWrapWidth,
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

/** Per-row layout: the transcript column budget and whether writers need naming. */
export function transcriptRowLayout(shell: AppShell): RowLayout {
  return {
    width: Math.max(1, shell.layout.contentWidth),
    multiAgent: shell.agentVoices.size > 1,
  };
}

/** Record a row's writer. True when the transcript gains a second voice, so earlier rows need labels. */
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

/** Writer label above the row at `index`, or null mid-block. A block is a gap-free run from one writer, so this reads `gapBefore`. */
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
 * Row at absolute `index` on the log `appendStreamRow` targets, so a tool
 * result can fold into the call row it answers. Evicted rows read as
 * undefined, same as past-the-end.
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
 * Marks a transcript child as the eviction notice. Identity, not state, is
 * the source of truth: the log base flips one step before the notice node
 * exists, so deriving the marker from state would misalign row indices.
 */
export const evictionMarkers = new WeakSet<BaseRenderable>();

/** `getChildren()` is not 1:1 with `streamLog` (bottom-anchor spacer, eviction notice), so row-only consumers go through here. */
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
 * Rewrite a row's body on its existing paint node, keeping parser block state
 * and styled line/table content. False when the node shape no longer matches
 * the row (a label or arrow appearing, a line-count change) and the caller
 * must rebuild it.
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

/** Last painted state per split markdown body, keyed by its column node. A rebuild gets a fresh node; stale entries die with the old row. */
const splitBodyMemory = new WeakMap<BaseRenderable, StreamMarkdownSnapshot>();

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
    paintPlainRowNode(
      node,
      row,
      paintStreamRow(row, layout),
      plainRowWrapWidth(row, layout),
    );
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
  const split = splitAtSettledBlock(content);

  // No settled block behind the tail: a lone renderer, same as an unsplit
  // body. A shape change falls through to the caller's rebuild.
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
  // Tail-only growth repaints just the live renderer: the frozen text is
  // already on screen at this width.
  const streaming = row.streaming === true;
  const transition = nextStreamMarkdownState(
    splitBodyMemory.get(bodyNode) ?? null,
    content,
    split.frozen,
    width,
    streaming,
  );
  splitBodyMemory.set(bodyNode, transition.state);
  bodyNode.width = width;
  frozenNode.width = width;
  if (transition.paintFrozen) {
    frozenNode.content = split.frozen;
    liveNode.marginTop = split.gapRows;
  }
  liveNode.width = width;
  liveNode.content = split.live;
  liveNode.streaming = streaming;
  return true;
}

/** Prefix column beside a body the renderer owns, pinned to the painted columns so an empty gutter costs none. */
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

/** Columns a markdown body may paint into: the transcript budget less the row's prefix. Pinned, because `flexGrow` reports intrinsic width and lets a wide table paint past the edge. */
function markdownBodyColumns(
  gutter: PaintedStreamLine,
  layout: RowLayout,
): number {
  return Math.max(1, layout.width - stringWidth(gutter.content));
}

/** Markdown tables shrink to the row's column budget: proportional columns, word-boundary wraps, and the body's pinned width clips the rest. */
const TRANSCRIPT_TABLE_OPTIONS = {
  wrapMode: "word",
  columnFitter: "proportional",
} as const;

function markdownContent(row: StreamRow): string {
  if (row.streaming !== true) return row.text;
  return withholdIncompleteHeading(row.text);
}

/** Build the row-shaped paint node: markdown body for assistant replies, table for structured rows, diff body for edit-tool rows, plain text otherwise. */
export function buildRowNode(
  ctx: CliRenderer,
  row: StreamRow,
  layout: RowLayout,
  onToggle?: () => void,
): TextRenderable | BoxRenderable {
  if (isSentenceRow(row)) {
    // One line cut to the columns beside the marker, so a long URL or query
    // cannot double the row.
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
    return buildPlainRowNode(
      ctx,
      row,
      paintStreamRow(row, layout),
      plainRowWrapWidth(row, layout),
    );
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

/** A literal-text row's paint node: a single text node, styled and click-armed when it holds URLs. */
function buildPlainRowNode(
  ctx: CliRenderer,
  row: StreamRow,
  painted: PaintedStreamLine,
  wrapWidth: number,
): TextRenderable {
  const node = new TextRenderable(ctx, {
    content: painted.content,
    fg: painted.fg,
  });
  paintPlainRowNode(node, row, painted, wrapWidth);
  return node;
}

/** Links a plain row's pre-wrap text holds, so a wrap across a short fragment line is told apart from a natural line break. */
function plainRowSourceUrls(row: StreamRow): string[] {
  return findLinks(`${row.text}\n${row.summary ?? ""}`).map((hit) => hit.url);
}

/** Rewrite a plain row's text on its existing node. The node never changes shape, so URL changes repaint in place. */
function paintPlainRowNode(
  node: TextRenderable,
  row: StreamRow,
  painted: PaintedStreamLine,
  wrapWidth: number,
): void {
  const lines = painted.content.split("\n");
  if (!lines.some((line) => findLinks(line).length > 0)) {
    node.content = painted.content;
    node.fg = painted.fg;
    // Route through the armer so dropping the last URL disarms handlers a
    // previous arming installed (armLinkLine clears them).
    armLinkLine(node, []);
    return;
  }
  paintLinkLine(
    node,
    splitWrappedLinkSpans(
      lines.map((text) => ({ text: text.trimEnd(), fg: painted.fg })),
      wrapWidth,
      plainRowSourceUrls(row),
    ),
  );
}

/**
 * Markdown body: one renderer until a block settles, then a `frozen`
 * renderer (never streamed or re-highlighted) above the still-`live` one.
 */
function createMarkdownBody(
  ctx: CliRenderer,
  row: StreamRow,
  gutter: PaintedStreamLine,
  layout: RowLayout,
): MarkdownRenderable | BoxRenderable {
  const width = markdownBodyColumns(gutter, layout);
  const content = markdownContent(row);
  const split = splitAtSettledBlock(content);
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
  splitBodyMemory.set(column, {
    content,
    frozen: split.frozen,
    width,
    streaming: row.streaming === true,
  });
  return column;
}

/** Gutter + one pre-coloured text line per body row (a diff, expanded tool arguments). Lines paint inside the body column, so wraps land under the body. */
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

/** One painted body line: an expand arrow splits into its own clickable renderable, URL lines arm as Ctrl+click targets, everything else a single text node. */
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

/** Gutter + native table body for a structured (MCP result) row, under its collapsed head lines, in one body column so the table stays in the gutter. */
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

/** Bare key the modal overlay claims for its expand/collapse hook. Not in SHELL_SHORTCUTS: live only while an overlay with `onToggleExpand` is open. */
export const OVERLAY_EXPAND_KEY = EXPAND_KEY;
