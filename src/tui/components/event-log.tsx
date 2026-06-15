import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, summarizeToolResult } from "../tool-formatter.js";
import { extractMcpRecords, extractMcpRecord } from "../mcp-result-format.js";
import { isMcpToolName } from "../../mcp/tool-name.js";
import { mcpRecordsToView, mcpRecordToView } from "../mcp-view.js";
import { viewToLines, type StyledLine } from "../view/index.js";
import { wrapLines, wrapRanges } from "../view/height.js";
import { color } from "../theme.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "plan" }>;

export type EventLogProps = {
  contentBlocks: ContentBlock[];
  scrollOffset: number;
  visibleRows: number;
  columns: number;
  thinkingExpanded: boolean;
  expandedTools: ReadonlySet<string>;
  verbose: boolean;
};

const LINE_PADDING = 2;
const SHELL_PREFIX = "$ ";

export function isRenderable(block: ContentBlock): block is RenderableBlock {
  return block.type !== "reply" && block.type !== "plan";
}

export function renderableBlocks(blocks: ContentBlock[]): RenderableBlock[] {
  return blocks.filter(isRenderable);
}

type RenderProps = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  dimColor?: boolean;
};

function segmentProps(seg: StyledSegment): RenderProps {
  const props: RenderProps = {};
  if (seg.bold) props.bold = true;
  if (seg.italic) props.italic = true;
  if (seg.strikethrough) props.strikethrough = true;
  if (seg.heading !== undefined) {
    props.bold = true;
    if (seg.heading === 1) props.color = color("brand");
    else if (seg.heading === 2) props.color = color("accent");
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
  // Explicit per-segment styling (views, shell prefix) wins over flag-derived
  // colours so the one render path serves both markdown and the view spec.
  if (seg.color !== undefined) props.color = seg.color;
  if (seg.dim) props.dimColor = true;
  return props;
}

function renderLine(line: StyledLine, key: string): ReactNode {
  const text = line.map((s) => s.text).join("");
  if (text.length === 0) {
    return <Text key={key}> </Text>;
  }
  return (
    <Text key={key}>
      {line.map((seg, i) => (
        <Text key={`${key}-${i}`} {...segmentProps(seg)}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

// Wrap a styled line into the visual rows it occupies, carrying each segment's
// styling across the soft breaks. This is how a tall logical line becomes many
// one-row lines, so the viewport can cut it anywhere.
function wrapStyledLine(segments: StyledSegment[], width: number): StyledLine[] {
  if (segments.length === 0) return [[]];
  const text = segments.map((s) => s.text).join("");
  return wrapRanges(text, width).map((range) => sliceSegments(segments, range.start, range.end));
}

// Slice a styled line's segments to the character range [start, end), preserving
// each surviving segment's styling.
function sliceSegments(segments: StyledSegment[], start: number, end: number): StyledSegment[] {
  const out: StyledSegment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    pos = segEnd;
    const from = Math.max(start, segStart);
    const to = Math.min(end, segEnd);
    if (to > from) out.push({ ...seg, text: seg.text.slice(from - segStart, to - segStart) });
  }
  return out;
}

function plainLines(content: string, base: Partial<StyledSegment>, width: number): StyledLine[] {
  return content.split("\n").flatMap((line) => wrapLines(line, width).map((row) => [{ ...base, text: row }]));
}

function markdownLines(content: string, width: number): StyledLine[] {
  return parseMarkdown(content, width).flatMap((segments) =>
    segments.length === 0 ? [[]] : wrapStyledLine(segments, width),
  );
}

function shellLines(command: string, role: string, width: number): StyledLine[] {
  const lines: StyledLine[] = [];
  command.split("\n").forEach((logical, li) => {
    const rowWidth = li === 0 ? Math.max(1, width - SHELL_PREFIX.length) : width;
    wrapLines(logical, rowWidth).forEach((row, ri) => {
      if (li === 0 && ri === 0) {
        lines.push([{ text: SHELL_PREFIX, color: color("muted"), dim: true }, { text: row, color: role }]);
      } else {
        lines.push([{ text: row, color: role }]);
      }
    });
  });
  return lines;
}

function toolCallLines(block: Extract<RenderableBlock, { type: "tool_call" }>, width: number, expanded: boolean): StyledLine[] {
  const { display, role, summary, full, isShell } = describeToolCall(block.name, block.arguments);
  const roleColor = color(role);

  if (isShell) {
    return shellLines(expanded ? full : summary, roleColor, width);
  }

  if (expanded) {
    const headline = wrapStyledLine([{ text: display, color: roleColor }], width);
    return full.length > 0 ? [...headline, ...plainLines(full, { color: color("muted") }, width)] : headline;
  }

  return wrapStyledLine(
    [
      { text: display, color: roleColor },
      ...(summary.length > 0 ? [{ text: ` ${summary}`, color: color("muted"), dim: true }] : []),
    ],
    width,
  );
}

function toolResultLines(block: Extract<RenderableBlock, { type: "tool_result" }>, columns: number, width: number, expanded: boolean): StyledLine[] {
  if (block.isError) {
    return plainLines(
      block.content
        .split("\n")
        .map((line, i) => (i === 0 ? "error: " : "") + line)
        .join("\n"),
      { color: color("danger") },
      width,
    );
  }

  if (isMcpToolName(block.name)) {
    const records = extractMcpRecords(block.content);
    if (records !== null) return viewToLines(mcpRecordsToView(records), columns);
    const record = extractMcpRecord(block.content);
    if (record !== null) return viewToLines(mcpRecordToView(record), columns);
  }

  const { preview, full, isJSONDocument } = summarizeToolResult(block.name, block.content);
  if (isJSONDocument) return markdownLines(full, width);
  if (expanded) return plainLines(full, { color: color("muted") }, width);
  return plainLines(preview, { color: color("muted"), dim: true }, width);
}

function blockToLines(block: RenderableBlock, columns: number, expanded: boolean, thinkingExpanded: boolean): StyledLine[] {
  const width = Math.max(8, columns - LINE_PADDING);

  switch (block.type) {
    case "thinking": {
      if (!thinkingExpanded) return [[{ text: "▸ thinking…", color: color("muted"), dim: true }]];
      return [
        [{ text: "▾ thinking", color: color("muted"), dim: true }],
        ...plainLines(block.content, { color: color("muted") }, width),
      ];
    }
    case "user":
      return plainLines(
        block.content
          .split("\n")
          .map((line, i) => (i === 0 ? "> " : "") + line)
          .join("\n"),
        { color: color("success") },
        width,
      );
    case "text":
      return markdownLines(block.content, width);
    case "tool_call":
      return toolCallLines(block, width, expanded);
    case "tool_result":
      return toolResultLines(block, columns, width, expanded);
    case "view":
      return viewToLines(block.node, columns);
    case "error":
      return plainLines(block.message, { color: color("danger") }, width);
    default:
      return [];
  }
}

// Render the whole event log to a flat array of styled lines, each exactly one
// visual row. The viewport slices this array by line index, so a tall block is
// cut at the viewport edge and can never overpaint past it.
export function buildLines(
  contentBlocks: ContentBlock[],
  columns: number,
  thinkingExpanded: boolean,
  isExpanded: (block: RenderableBlock) => boolean,
): StyledLine[] {
  const blocks = renderableBlocks(contentBlocks).filter((b) => thinkingExpanded || b.type !== "thinking");
  const lines: StyledLine[] = [];
  for (const block of blocks) {
    const startsTurn = block.type === "user" || block.type === "text";
    if (startsTurn && lines.length > 0) lines.push([]);
    lines.push(...blockToLines(block, columns, isExpanded(block), thinkingExpanded));
  }
  return lines;
}

export function maxLineOffset(lines: StyledLine[], visibleRows: number): number {
  return Math.max(0, lines.length - visibleRows);
}

export function lineWindow(lines: StyledLine[], scrollOffset: number, visibleRows: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(scrollOffset, maxLineOffset(lines, visibleRows)));
  const end = Math.min(lines.length, start + Math.max(1, visibleRows));
  return { start, end };
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
  const isExpanded = (block: RenderableBlock): boolean => verbose || expandedTools.has(block.id);
  const lines = buildLines(contentBlocks, columns, thinkingExpanded, isExpanded);

  if (lines.length === 0) {
    return <Box paddingX={1} />;
  }

  const { start, end } = lineWindow(lines, scrollOffset, visibleRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.slice(start, end).map((line, i) => renderLine(line, `line-${start + i}`))}
    </Box>
  );
}
