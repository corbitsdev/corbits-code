import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, summarizeToolResult } from "../tool-formatter.js";
import { extractMcpRecords, extractMcpRecord } from "../mcp-result-format.js";
import { isMcpToolName } from "../../mcp/tool-name.js";
import { mcpRecordsToView, mcpRecordToView } from "../mcp-view.js";
import { View, viewHeight } from "../view/index.js";
import { wrapCount, wrapLines, wrapRanges } from "../view/height.js";
import { color } from "../theme.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "plan" }>;

export type LineUnit = { key: string; node: ReactNode; rows: number };

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
const ELLIPSIS = "…";

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

function truncateToWidth(text: string, available: number): string {
  const avail = Math.max(8, available);
  if (text.length <= avail) return text;
  const head = Math.max(0, avail - ELLIPSIS.length);
  return text.slice(0, head) + ELLIPSIS;
}

export function truncateLine(text: string, columns: number, expanded: boolean): string {
  if (expanded) return text;
  return truncateToWidth(text, columns - LINE_PADDING);
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

function lineRows(text: string, width: number): number {
  return wrapCount(text.length > 0 ? text : " ", width);
}

// Slice a styled line's segments to the character range [start, end), preserving
// each surviving segment's styling. Used to carry inline markdown styling across
// the visual rows a wrapped line breaks into.
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

// One unit per visual row, each exactly one row tall. Because we wrap the styled
// line ourselves and render rows that already fit the width, Ink never re-wraps,
// so the unit's row count is exact and the scroll window can step one row at a time.
function markdownUnits(content: string, width: number, keyPrefix: string): LineUnit[] {
  const units: LineUnit[] = [];
  parseMarkdown(content).forEach((segments, li) => {
    if (segments.length === 0) {
      const key = `${keyPrefix}-l${li}`;
      units.push({ key, node: <Text key={key}> </Text>, rows: 1 });
      return;
    }
    const text = segments.map((s) => s.text).join("");
    wrapRanges(text, width).forEach((range, ri) => {
      const rowSegments = sliceSegments(segments, range.start, range.end);
      const key = `${keyPrefix}-l${li}-r${ri}`;
      units.push({
        key,
        node: (
          <Text key={key}>
            {rowSegments.length > 0 ? renderMarkdownSegments(rowSegments) : " "}
          </Text>
        ),
        rows: 1,
      });
    });
  });
  return units;
}

function plainUnits(content: string, props: TextProps & { dimColor?: boolean }, width: number, keyPrefix: string): LineUnit[] {
  const units: LineUnit[] = [];
  content.split("\n").forEach((line, li) => {
    wrapLines(line, width).forEach((row, ri) => {
      const key = `${keyPrefix}-l${li}-r${ri}`;
      units.push({
        key,
        node: (
          <Text key={key} {...props}>
            {row.length > 0 ? row : " "}
          </Text>
        ),
        rows: 1,
      });
    });
  });
  return units;
}

function toolCallUnits(block: Extract<RenderableBlock, { type: "tool_call" }>, columns: number, width: number, expanded: boolean): LineUnit[] {
  const id = block.id;
  const { display, role, summary, full, isShell } = describeToolCall(block.name, block.arguments);
  const SHELL_PREFIX = "$ ";

  if (isShell) {
    const command = expanded ? full : summary;
    return [
      {
        key: `${id}-h`,
        node: (
          <Box key={`${id}-h`} flexDirection="row">
            <Text color={color("muted")} dimColor>{SHELL_PREFIX}</Text>
            <Text color={color(role)}>{command}</Text>
          </Box>
        ),
        rows: lineRows(`${SHELL_PREFIX}${command}`, width),
      },
    ];
  }

  if (expanded) {
    const headline: LineUnit = {
      key: `${id}-h`,
      node: <Text key={`${id}-h`} color={color(role)}>{display}</Text>,
      rows: lineRows(display, width),
    };
    return full.length > 0 ? [headline, ...plainUnits(full, { color: color("muted") }, width, id)] : [headline];
  }

  const summaryText = summary;
  return [
    {
      key: `${id}-h`,
      node: (
        <Box key={`${id}-h`} flexDirection="row">
          <Text color={color(role)}>{display}</Text>
          {summaryText.length > 0 ? <Text color={color("muted")} dimColor> {summaryText}</Text> : null}
        </Box>
      ),
      rows: lineRows(summaryText.length > 0 ? `${display} ${summaryText}` : display, width),
    },
  ];
}

function toolResultUnits(block: Extract<RenderableBlock, { type: "tool_result" }>, columns: number, width: number, expanded: boolean): LineUnit[] {
  const id = block.id;

  if (block.isError) {
    return plainUnits(
      block.content
        .split("\n")
        .map((line, i) => (i === 0 ? "error: " : "") + line)
        .join("\n"),
      { color: color("danger") },
      width,
      id,
    );
  }

  if (isMcpToolName(block.name)) {
    const records = extractMcpRecords(block.content);
    if (records !== null) {
      const view = mcpRecordsToView(records);
      return [{ key: id, node: <View key={id} node={view} columns={columns} />, rows: viewHeight(view, columns) }];
    }
    const record = extractMcpRecord(block.content);
    if (record !== null) {
      const view = mcpRecordToView(record);
      return [{ key: id, node: <View key={id} node={view} columns={columns} />, rows: viewHeight(view, columns) }];
    }
  }

  const { preview, full, isJSONDocument } = summarizeToolResult(block.name, block.content);
  if (isJSONDocument) {
    return markdownUnits(full, width, id);
  }
  if (expanded) {
    return plainUnits(full, { color: color("muted") }, width, id);
  }
  return plainUnits(preview, { color: color("muted"), dimColor: true }, width, id);
}

function blockToUnits(block: RenderableBlock, columns: number, expanded: boolean, thinkingExpanded: boolean): LineUnit[] {
  const width = Math.max(8, columns - LINE_PADDING);
  const id = block.id;

  switch (block.type) {
    case "thinking": {
      if (!thinkingExpanded) {
        return [{ key: id, node: <Text key={id} color={color("muted")} dimColor>▸ thinking…</Text>, rows: 1 }];
      }
      return [
        { key: `${id}-h`, node: <Text key={`${id}-h`} color={color("muted")} dimColor>▾ thinking</Text>, rows: 1 },
        ...plainUnits(block.content, { color: color("muted") }, width, id),
      ];
    }
    case "user":
      return plainUnits(
        block.content
          .split("\n")
          .map((line, i) => (i === 0 ? "> " : "") + line)
          .join("\n"),
        { color: color("success") },
        width,
        id,
      );
    case "text":
      return markdownUnits(block.content, width, id);
    case "tool_call":
      return toolCallUnits(block, columns, width, expanded);
    case "tool_result":
      return toolResultUnits(block, columns, width, expanded);
    case "view":
      return [{ key: id, node: <View key={id} node={block.node} columns={columns} />, rows: viewHeight(block.node, columns) }];
    case "error":
      return plainUnits(block.message, { color: color("danger") }, width, id);
    default:
      return [];
  }
}

export function buildLineUnits(
  contentBlocks: ContentBlock[],
  columns: number,
  thinkingExpanded: boolean,
  isExpanded: (block: RenderableBlock) => boolean,
): LineUnit[] {
  const blocks = renderableBlocks(contentBlocks).filter((b) => thinkingExpanded || b.type !== "thinking");
  const units: LineUnit[] = [];
  for (const block of blocks) {
    const startsTurn = block.type === "user" || block.type === "text";
    if (startsTurn && units.length > 0) {
      units.push({ key: `sp-${block.id}`, node: <Text key={`sp-${block.id}`}> </Text>, rows: 1 });
    }
    units.push(...blockToUnits(block, columns, isExpanded(block), thinkingExpanded));
  }
  return units;
}

export function maxScrollOffset(units: LineUnit[], visibleRows: number): number {
  let rows = 0;
  let start = units.length;
  for (let i = units.length - 1; i >= 0; i--) {
    const next = units[i]!.rows;
    if (rows + next > visibleRows && start < units.length) break;
    rows += next;
    start = i;
  }
  return Math.max(0, start);
}

export function visibleLineWindow(units: LineUnit[], scrollOffset: number, visibleRows: number): { start: number; end: number } {
  if (units.length === 0) return { start: 0, end: 0 };

  const start = Math.max(0, Math.min(scrollOffset, maxScrollOffset(units, visibleRows)));
  let rows = 0;
  let end = start;
  for (let i = start; i < units.length; i++) {
    const next = units[i]!.rows;
    if (rows + next > visibleRows && end > start) break;
    rows += next;
    end = i + 1;
  }
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
  const units = buildLineUnits(contentBlocks, columns, thinkingExpanded, isExpanded);

  if (units.length === 0) {
    return <Box paddingX={1} />;
  }

  const { start, end } = visibleLineWindow(units, scrollOffset, visibleRows);

  return (
    <Box flexDirection="column" paddingX={1}>
      {units.slice(start, end).map((unit) => (
        <Box key={unit.key}>{unit.node}</Box>
      ))}
    </Box>
  );
}
