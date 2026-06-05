import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, summarizeToolResult } from "../tool-formatter.js";
import { color } from "../theme.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "plan" }>;

export type EventLogProps = {
  contentBlocks: ContentBlock[];
  scrollOffset: number;
  visibleRows: number;
  columns: number;
  thinkingExpanded: boolean;
  expandedTools: ReadonlySet<number>;
  verbose: boolean;
};

const LINE_PADDING = 2;
const SHOW_MORE = "… [show more]";

export function isRenderable(block: ContentBlock): block is RenderableBlock {
  return block.type !== "reply" && block.type !== "plan";
}

export function renderableBlocks(blocks: ContentBlock[]): RenderableBlock[] {
  return blocks.filter(isRenderable);
}

export function clampOffset(offset: number, total: number, visibleRows: number): number {
  const maxOffset = Math.max(0, total - visibleRows);
  if (offset < 0) return 0;
  if (offset > maxOffset) return maxOffset;
  return offset;
}

export function windowBlocks<T>(blocks: T[], scrollOffset: number, visibleRows: number): T[] {
  const start = clampOffset(scrollOffset, blocks.length, visibleRows);
  return blocks.slice(start, start + visibleRows);
}

// Roughly how many terminal rows a block will paint at this width. Used only to
// bound the visible window so the log never emits more rows than the viewport —
// emitting more than the terminal can show makes Ink's redraw desync and ghost
// stale text. The estimate errs toward overcounting (safer: shows slightly less).
function estimateRows(
  block: RenderableBlock,
  columns: number,
  thinkingExpanded: boolean,
  expanded: boolean,
): number {
  const width = Math.max(8, columns - LINE_PADDING);
  const wrap = (text: string): number => Math.max(1, Math.ceil(text.length / width));
  const sumLines = (content: string): number =>
    content.split("\n").reduce((n, line) => n + wrap(line), 0);

  switch (block.type) {
    case "user":
      return expanded ? sumLines(block.content) : 1;
    case "thinking":
      return thinkingExpanded ? 1 + sumLines(block.content) : 1;
    case "text":
      return sumLines(block.content);
    case "tool_call":
      return expanded ? 1 + sumLines(block.arguments) : 1;
    case "tool_result": {
      if (block.isError) return wrap(block.content);
      const { full, isJSONDocument } = summarizeToolResult(block.name, block.content);
      // JSON documents render via parseMarkdown which transforms tables (drops
      // the separator row, pads cells) so the rendered line count differs from
      // the raw newline count. Count parsed lines directly to stay accurate.
      if (isJSONDocument) return parseMarkdown(full).length;
      return expanded ? sumLines(full) : 1;
    }
    case "error":
      return sumLines(block.message);
    default:
      return 1;
  }
}

// Select the slice to render: take the bottom of the current block window, then
// walk upward accumulating estimated rows until the viewport is full. This keeps
// the newest content visible and guarantees the painted height never exceeds
// `visibleRows`, which is what prevents the ghosting on overflow.
export function visibleWindow(
  blocks: RenderableBlock[],
  scrollOffset: number,
  visibleRows: number,
  columns: number,
  thinkingExpanded: boolean,
  isExpanded: (absoluteIndex: number) => boolean,
): { start: number; end: number } {
  if (blocks.length === 0) return { start: 0, end: 0 };
  if (scrollOffset >= blocks.length - 1) {
    const end = blocks.length;
    let rows = 0;
    let start = end;
    for (let i = end - 1; i >= 0; i--) {
      const block = blocks[i]!;
      const spaced = block.type === "user" || block.type === "text";
      const next =
        estimateRows(block, columns, thinkingExpanded, isExpanded(i)) + (spaced ? 1 : 0);
      if (rows + next > visibleRows && start < end) break;
      rows += next;
      start = i;
    }
    return { start, end };
  }

  const start = Math.max(0, Math.min(scrollOffset, blocks.length - 1));
  let rows = 0;
  let end = start;
  for (let i = start; i < blocks.length; i++) {
    const block = blocks[i]!;
    const spaced = i > start && (block.type === "user" || block.type === "text");
    const next =
      estimateRows(block, columns, thinkingExpanded, isExpanded(i)) + (spaced ? 1 : 0);
    if (rows + next > visibleRows && end > start) break;
    rows += next;
    end = i + 1;
  }
  return { start, end };
}

export function truncateLine(text: string, columns: number, expanded: boolean): string {
  if (expanded) return text;
  const available = Math.max(8, columns - LINE_PADDING);
  if (text.length <= available) return text;
  const head = Math.max(0, available - SHOW_MORE.length);
  return text.slice(0, head) + SHOW_MORE;
}

function truncateContentRows(content: string, columns: number, maxRows: number): string {
  const width = Math.max(8, columns - LINE_PADDING);
  const rows: string[] = [];
  let clipped = false;

  for (const sourceLine of content.split("\n")) {
    const line = sourceLine.length === 0 ? " " : sourceLine;
    for (let start = 0; start < line.length; start += width) {
      if (rows.length >= maxRows) {
        clipped = true;
        break;
      }
      rows.push(line.slice(start, start + width));
    }
    if (clipped) break;
  }

  if (!clipped) return content;
  if (rows.length === 0) return SHOW_MORE;
  const last = rows[rows.length - 1] ?? "";
  const head = Math.max(0, width - SHOW_MORE.length);
  rows[rows.length - 1] = last.slice(0, head) + SHOW_MORE;
  return rows.join("\n");
}

type TextProps = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
};

function segmentProps(seg: StyledSegment): TextProps {
  const props: TextProps = {};
  if (seg.bold) props.bold = true;
  if (seg.italic) props.italic = true;
  if (seg.strikethrough) props.strikethrough = true;
  if (seg.heading !== undefined) {
    props.bold = true;
    if (seg.heading === 1) props.color = color("brand");
    else if (seg.heading === 2) props.color = color("accent");
    // h3–h6 are bold in the default text colour.
  }
  if (seg.link) {
    props.underline = true;
    props.color = color("accent");
  }
  if (seg.blockquote) {
    props.italic = true;
    props.color = color("muted");
  }
  if (seg.rule) props.color = color("muted");
  if (seg.bullet && /^\s*(•|\d+\.)/.test(seg.text)) props.color = color("muted");
  if (seg.code) props.color = color("muted");
  return props;
}

function renderMarkdownSegments(segments: StyledSegment[]): ReactNode[] {
  return segments.map((seg, i) => (
    <Text key={`seg-${i}`} {...segmentProps(seg)}>
      {seg.text}
    </Text>
  ));
}

function renderMarkdownLines(content: string): ReactNode {
  const lines = parseMarkdown(content);
  return (
    <Box flexDirection="column">
      {lines.map((lineSegments, i) =>
        // Each line is ONE Text with nested Text children for inline styles. Ink
        // only wraps within a single Text node, never across sibling nodes in a
        // row Box — so mounting segments as a row makes every styled word an
        // unwrappable atom. Nesting them lets the line flow and wrap normally.
        lineSegments.length === 0 ? (
          <Text key={`line-${i}`}> </Text>
        ) : (
          <Text key={`line-${i}`}>{renderMarkdownSegments(lineSegments)}</Text>
        ),
      )}
    </Box>
  );
}

function renderBlock(
  block: RenderableBlock,
  index: number,
  columns: number,
  expanded: boolean,
  thinkingExpanded: boolean,
  rowLimit: number,
): ReactNode {
  const key = `${block.type}-${index}`;
  switch (block.type) {
    case "thinking": {
      if (!thinkingExpanded) {
        return (
          <Text key={key} color={color("muted")} dimColor>
            ▸ thinking…
          </Text>
        );
      }
      return (
        <Box key={key} flexDirection="column">
          <Text color={color("muted")} dimColor>
            ▾ thinking
          </Text>
          <Text color={color("muted")}>{block.content}</Text>
        </Box>
      );
    }
    case "user":
      return (
        <Text key={key} color={color("success")}>
          {truncateLine(`> ${block.content}`, columns, expanded)}
        </Text>
      );
    case "text":
      return <Box key={key}>{renderMarkdownLines(truncateContentRows(block.content, columns, rowLimit))}</Box>;
    case "tool_call": {
      const { display, role, summary, full, isShell } = describeToolCall(block.name, block.arguments);
      if (isShell) {
        // Lean shell: a dim prompt glyph, then the command as the headline.
        const command = expanded ? full : truncateLine(summary, columns, false);
        return (
          <Box key={key} flexDirection="column">
            <Box flexDirection="row">
              <Text color={color("muted")} dimColor>$ </Text>
              <Text color={color(role)}>{command}</Text>
            </Box>
          </Box>
        );
      }
      const argsLine = expanded ? full : truncateLine(summary, columns, false);
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row">
            <Text color={color(role)}>{display}</Text>
            {summary.length > 0 ? <Text> </Text> : null}
            {!expanded && summary.length > 0 ? (
              <Text color={color("muted")} dimColor>
                {argsLine}
              </Text>
            ) : null}
          </Box>
          {expanded && full.length > 0 ? (
            <Text color={color("muted")}>{full}</Text>
          ) : null}
        </Box>
      );
    }
    case "tool_result": {
      if (block.isError) {
        return (
          <Text key={key} color={color("danger")}>
            error: {truncateLine(block.content, columns, expanded)}
          </Text>
        );
      }
      const { preview, full, isJSONDocument } = summarizeToolResult(block.name, block.content);
      if (isJSONDocument) {
        return <Box key={key}>{renderMarkdownLines(full)}</Box>;
      }
      const line = expanded ? full : truncateLine(preview, columns, false);
      if (expanded) {
        return (
          <Text key={key} color={color("muted")}>
            {line}
          </Text>
        );
      }
      return (
        <Text key={key} color={color("muted")} dimColor>
          {line}
        </Text>
      );
    }
    case "error":
      return (
        <Box key={key} flexDirection="column">
          {block.message.split("\n").map((line, i) => (
            <Text key={i} color={color("danger")}>{line}</Text>
          ))}
        </Box>
      );
    default:
      return null;
  }
}

export function EventLog({
  contentBlocks,
  scrollOffset,
  visibleRows,
  columns,
  thinkingExpanded,
  expandedTools,
  verbose,
}: EventLogProps): ReactNode {
  const entries = renderableBlocks(contentBlocks)
    .map((block, index) => ({ block, index }))
    .filter((entry) => thinkingExpanded || entry.block.type !== "thinking");
  const blocks = entries.map((entry) => entry.block);

  if (blocks.length === 0) {
    // Nothing to show yet — stay blank rather than announcing an empty state.
    return <Box paddingX={1} />;
  }

  const isExpanded = (absoluteIndex: number): boolean => verbose || expandedTools.has(absoluteIndex);
  const { start, end } = visibleWindow(
    blocks,
    scrollOffset,
    visibleRows,
    columns,
    thinkingExpanded,
    (filteredIndex) => isExpanded(entries[filteredIndex]?.index ?? filteredIndex),
  );
  const visible = entries.slice(start, end);

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map(({ block, index: absoluteIndex }, i) => {
        const expanded = isExpanded(absoluteIndex);
        const node = renderBlock(block, absoluteIndex, columns, expanded, thinkingExpanded, visibleRows);
        // A little breathing room before each conversational turn (a user
        // message or an assistant reply), while tool call/result sequences stay
        // tight together.
        const spaced = i > 0 && (block.type === "user" || block.type === "text");
        return (
          <Box key={`row-${absoluteIndex}`} marginTop={spaced ? 1 : 0}>
            {node}
          </Box>
        );
      })}
    </Box>
  );
}
