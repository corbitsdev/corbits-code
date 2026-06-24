import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import type { ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, mergedToolCollapsedPreview, summarizeToolResult } from "../tool-formatter.js";
import { extractMcpRecords, extractMcpRecord } from "../mcp-result-format.js";
import { isMcpToolName } from "../../mcp/tool-name.js";
import { mcpRecordsToView, mcpRecordToView } from "../mcp-view.js";
import { viewToLines, type StyledLine } from "../view/index.js";
import { wrapLines, wrapRanges } from "../view/height.js";
import { color } from "../theme.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "tasks" }>;

export type EventLogProps = {
  lines: StyledLine[];
  scrollOffset: number;
  visibleRows: number;
  width: number;
};

const SHELL_PREFIX = "$ ";
const USER_CODE_BLOCK_LINE_LIMIT = 12;
// Tool calls and results sit one level below assistant prose so the model's
// text draws the eye and tools read as subordinate actions.
const TOOL_INDENT = 2;
// Horizontal gutters keep prose off the terminal edges so wrapped lines
// don't sit flush against the window border.
export const TEXT_GUTTER = 2;

function indentLines(lines: StyledLine[], spaces: number): StyledLine[] {
  if (spaces <= 0) return lines;
  const pad: StyledSegment = { text: " ".repeat(spaces) };
  return lines.map((line) => [pad, ...line]);
}

const CACHE_KEY_SEPARATOR = "\x1f";

function blockCacheKey(block: RenderableBlock, columns: number, expanded: boolean): string {
  return [block.id, String(columns), expanded ? "1" : "0"].join(CACHE_KEY_SEPARATOR);
}

function blockIdFromCacheKey(key: string): string {
  return key.split(CACHE_KEY_SEPARATOR, 1)[0] ?? key;
}

export function isRenderable(block: ContentBlock): block is RenderableBlock {
  return block.type !== "reply" && block.type !== "tasks";
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
  backgroundColor?: string;
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
    else props.color = color("success");
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
  if (seg.bullet && /^\s*(•|\d+\.)/.test(seg.text)) props.color = color("accent");
  if (seg.code) props.color = color("warning");
  // Explicit per-segment styling (views, shell prefix) wins over flag-derived
  // colours so the one render path serves both markdown and the view spec.
  if (seg.color !== undefined) props.color = seg.color;
  if (seg.dim) props.dimColor = true;
  if (seg.backgroundColor !== undefined) props.backgroundColor = seg.backgroundColor;
  return props;
}

function renderLine(line: StyledLine, key: string, width: number): ReactNode {
  const text = line.map((s) => s.text).join("");
  const pad = Math.max(0, width - text.length);
  const paddedLine = pad > 0 ? [...line, { text: " ".repeat(pad) }] : line;

  return (
    <Text key={key}>
      {paddedLine.map((seg, i) => (
        <Text key={`${key}-${i}`} {...segmentProps(seg)}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

function wrapStyledLine(segments: StyledSegment[], width: number): StyledLine[] {
  if (segments.length === 0) return [[]];
  const text = segments.map((s) => s.text).join("");
  return wrapRanges(text, width).map((range) => sliceSegments(segments, range.start, range.end));
}

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

function sanitizeTerminalControls(content: string): string {
  return content
    .replace(/\x1B\[<\d+;\d+;\d+[Mm]/g, "")
    .replace(/\[<\d+;\d+;\d+[Mm]/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function plainLines(content: string, base: Partial<StyledSegment>, width: number): StyledLine[] {
  return sanitizeTerminalControls(content)
    .split("\n")
    .flatMap((line) => wrapLines(line, width).map((row) => [{ ...base, text: row }]));
}

function compactUserCodeBlocks(content: string): string {
  return content.replace(/```([^\n`]*)\n([\s\S]*?)\n```/g, (match, language: string, body: string) => {
    const lineCount = body.length === 0 ? 0 : body.split("\n").length;
    if (lineCount <= USER_CODE_BLOCK_LINE_LIMIT) return match;
    const label = language.trim().length > 0 ? `${language.trim()} code block` : "code block";
    return `[${label} hidden: ${lineCount} lines]`;
  });
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
    const headline = wrapStyledLine([{ text: "● ", color: roleColor }, { text: display, color: roleColor }], width);
    return full.length > 0 ? [...headline, ...plainLines(full, { color: color("muted") }, width)] : headline;
  }

  // Collapsed non-shell tool calls are subordinate — danger stays loud, everything
  // else recedes so the model's actual text output draws the eye instead. The
  // leading bullet stays in the action colour so a call still reads as a call.
  const collapsedColor = role === "danger" ? roleColor : color("muted");
  return wrapStyledLine(
    [
      { text: "● ", color: roleColor, dim: role !== "danger" },
      { text: display, color: collapsedColor, dim: role !== "danger" },
      ...(summary.length > 0 ? [{ text: ` ${summary}`, color: color("dim"), dim: true }] : []),
    ],
    width,
  );
}

function mergedToolLines(
  call: Extract<RenderableBlock, { type: "tool_call" }>,
  result: Extract<RenderableBlock, { type: "tool_result" }>,
  width: number,
): StyledLine[] {
  const { role, isShell } = describeToolCall(call.name, call.arguments);
  const merged = mergedToolCollapsedPreview(call.name, call.arguments, result.content, result.isError);
  const roleColor = color(role);

  if (isShell) {
    const arrow = merged.includes(" → ") ? merged.split(" → ") : [merged];
    const command = arrow[0] ?? merged;
    const suffix = arrow[1];
    const base = shellLines(command, roleColor, width);
    if (suffix === undefined || suffix.length === 0) return base;
    const last = base[base.length - 1];
    if (last === undefined) return base;
    return [
      ...base.slice(0, -1),
      [...last, { text: ` → ${suffix}`, color: color("dim"), dim: true }],
    ];
  }

  const collapsedColor = role === "danger" ? roleColor : color("muted");
  return wrapStyledLine(
    [
      { text: "● ", color: roleColor, dim: role !== "danger" },
      { text: merged, color: collapsedColor, dim: role !== "danger" },
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
  if (expanded) {
    return isJSONDocument ? markdownLines(full, width) : plainLines(full, { color: color("muted") }, width);
  }
  return plainLines(preview, { color: color("muted"), dim: true }, width);
}

export type PlanContext = {
  currentStep: number | null;
  deviated: boolean;
};

function planStepLines(
  block: Extract<RenderableBlock, { type: "plan" }>,
  width: number,
  ctx: PlanContext | undefined,
): StyledLine[] {
  const currentStep = ctx?.currentStep ?? null;
  const deviated = ctx?.deviated ?? false;

  const lines: StyledLine[] = [];
  block.steps.forEach((step, i) => {
    const isDone = currentStep !== null && i < currentStep;
    const isActive = currentStep !== null && i === currentStep;
    const isCancelled = deviated && currentStep !== null && i >= currentStep && !isActive;

    const text = `${step.action} ${step.file}`.trim();

    if (isDone) {
      lines.push([
        { text: "✓ ", color: color("success") },
        { text, color: color("muted"), strikethrough: true, dim: true },
      ]);
    } else if (isActive) {
      lines.push([
        { text: "◯ ", color: color("text") },
        { text, color: color("text"), bold: true },
      ]);
    } else if (isCancelled) {
      lines.push([
        { text: "✗ ", color: color("danger") },
        { text: "cancelled", color: color("danger") },
        { text: ` ${text}`, color: color("dim"), dim: true },
      ]);
    } else {
      lines.push([
        { text: "○ ", color: color("muted"), dim: true },
        { text, color: color("muted"), dim: true },
      ]);
    }
  });
  return lines;
}

function blockToLines(
  block: RenderableBlock,
  columns: number,
  expanded: boolean,
  thinkingExpanded: boolean,
  planCtx?: PlanContext,
): StyledLine[] {
  const width = Math.max(8, columns);

  switch (block.type) {
    case "thinking": {
      if (!thinkingExpanded) return [[{ text: "▸ thinking…", color: color("muted"), dim: true }]];
      const thinkingContentLines = plainLines(block.content, { color: color("muted"), dim: true }, width);
      // Gutter prefix distinguishes thinking from model output at a glance.
      const prefixedLines: StyledLine[] = thinkingContentLines.map((line) => [
        { text: "│ ", color: color("dim"), dim: true },
        ...line,
      ]);
      return [
        [{ text: "▾ thinking", color: color("muted"), dim: true }],
        ...prefixedLines,
      ];
    }
    case "user": {
      const accentBg = color("brand");
      const bg = "#050505";
      const userLines = plainLines(
        compactUserCodeBlocks(block.content),
        { color: "#ffffff", backgroundColor: bg },
        width,
      );
      // Fill the entire row so the user message reads as a full-width banner,
      // with a thin brand-colored rail at the left edge.
      return userLines.map((line) => {
        const textLen = line.reduce((n, s) => n + s.text.length, 0);
        const pad = Math.max(0, width - textLen - 3);
        return [
          { text: "  ", backgroundColor: accentBg },
          { text: " ", backgroundColor: bg },
          ...line,
          { text: " ".repeat(pad), backgroundColor: bg },
        ];
      });
    }
    case "text": {
      const textLines = markdownLines(block.content, width);
      // Leading marker keeps assistant prose visually separate from the colored
      // user banner while staying quiet in the layout.
      if (textLines.length === 0) return textLines;
      // Fold the marker into the wrap budget so a full first line doesn't
      // overflow the column — an uncounted spill row would push the viewport's
      // bottom line (the newest text) out of view.
      const firstWrapped = wrapStyledLine(
        [{ text: " ● ", color: color("text") }, ...(textLines[0] ?? [])],
        width,
      );
      return [...firstWrapped, ...textLines.slice(1)];
    }
    case "tool_call":
      return indentLines(toolCallLines(block, width - TOOL_INDENT, expanded), TOOL_INDENT);
    case "tool_result":
      return indentLines(toolResultLines(block, columns, width - TOOL_INDENT, expanded), TOOL_INDENT);
    case "view":
      return viewToLines(block.node, columns);
    case "error":
      return plainLines(block.message, { color: color("danger") }, width);
    case "plan":
      return planStepLines(block, width, planCtx);
    default:
      return [];
  }
}

type AssembleBlocksArgs = {
  blocks: RenderableBlock[];
  columns: number;
  thinkingExpanded: boolean;
  isExpanded: (block: RenderableBlock) => boolean;
  cache?: Map<string, StyledLine[]>;
  planCtx?: PlanContext;
  startBlockIndex: number;
  prefixLines: StyledLine[];
};

function pruneBlockLineCache(cache: Map<string, StyledLine[]>, blocks: RenderableBlock[]): void {
  const activeIds = new Set(blocks.map((b) => b.id));
  for (const key of cache.keys()) {
    if (!activeIds.has(blockIdFromCacheKey(key))) cache.delete(key);
  }
}

function assembleRenderableBlocks(args: AssembleBlocksArgs): { lines: StyledLine[]; blockLineStarts: number[] } {
  const {
    blocks,
    columns,
    thinkingExpanded,
    isExpanded,
    cache,
    planCtx,
    startBlockIndex,
    prefixLines,
  } = args;
  const lines = [...prefixLines];
  const blockLineStarts = new Array<number>(blocks.length);
  const lastIdx = blocks.length - 1;

  for (let i = startBlockIndex; i < blocks.length; i++) {
    blockLineStarts[i] = lines.length;
    const block = blocks[i]!;
    const next = blocks[i + 1];
    const startsTurn = block.type === "user" || block.type === "text";
    if (startsTurn && lines.length > 0) lines.push([]);

    if (
      block.type === "tool_call"
      && next?.type === "tool_result"
      && next.name === block.name
      && !isExpanded(block)
      && !isExpanded(next)
    ) {
      const mergedLines = indentLines(
        mergedToolLines(block, next, Math.max(8, columns) - TOOL_INDENT),
        TOOL_INDENT,
      );
      lines.push(...mergedLines);
      if (i + 1 < blocks.length) blockLineStarts[i + 1] = lines.length;
      i++;
      continue;
    }

    const expanded = isExpanded(block);
    const isStreaming = i === lastIdx || block.type === "plan";
    let blockLines: StyledLine[];

    if (cache !== undefined && !isStreaming) {
      const key = blockCacheKey(block, columns, expanded);
      const cached = cache.get(key);
      if (cached !== undefined) {
        blockLines = cached;
      } else {
        blockLines = blockToLines(block, columns, expanded, thinkingExpanded, planCtx);
        cache.set(key, blockLines);
      }
    } else {
      blockLines = blockToLines(block, columns, expanded, thinkingExpanded, planCtx);
    }
    lines.push(...blockLines);
  }

  return { lines, blockLineStarts };
}

export type IncrementalLinesState = {
  blocks: RenderableBlock[];
  lines: StyledLine[];
  blockLineStarts: number[];
  layoutKey: string;
};

export function buildLinesIncremental(
  prev: IncrementalLinesState | undefined,
  contentBlocks: ContentBlock[],
  columns: number,
  thinkingExpanded: boolean,
  isExpanded: (block: RenderableBlock) => boolean,
  cache?: Map<string, StyledLine[]>,
  planCtx?: PlanContext,
  layoutKey?: string,
): IncrementalLinesState {
  const blocks = renderableBlocks(contentBlocks).filter((b) => thinkingExpanded || b.type !== "thinking");
  if (cache !== undefined) pruneBlockLineCache(cache, blocks);

  const key = layoutKey ?? "";

  let startBlockIndex = 0;
  let prefixLines: StyledLine[] = [];

  if (
    prev !== undefined
    && prev.layoutKey === key
    && prev.blocks.length === blocks.length
    && blocks.length > 0
  ) {
    let firstDiff = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] !== prev.blocks[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff >= blocks.length - 1) {
      startBlockIndex = firstDiff >= blocks.length ? blocks.length - 1 : firstDiff;
      prefixLines = prev.lines.slice(0, prev.blockLineStarts[startBlockIndex] ?? 0);
    }
  }

  const { lines, blockLineStarts } = assembleRenderableBlocks({
    blocks,
    columns,
    thinkingExpanded,
    isExpanded,
    ...(cache !== undefined ? { cache } : {}),
    ...(planCtx !== undefined ? { planCtx } : {}),
    startBlockIndex,
    prefixLines,
  });

  if (prev !== undefined && startBlockIndex > 0) {
    for (let i = 0; i < startBlockIndex; i++) {
      blockLineStarts[i] = prev.blockLineStarts[i] ?? 0;
    }
  }

  return { blocks, lines, blockLineStarts, layoutKey: key };
}

export function buildLines(
  contentBlocks: ContentBlock[],
  columns: number,
  thinkingExpanded: boolean,
  isExpanded: (block: RenderableBlock) => boolean,
  cache?: Map<string, StyledLine[]>,
  planCtx?: PlanContext,
): StyledLine[] {
  return buildLinesIncremental(
    undefined,
    contentBlocks,
    columns,
    thinkingExpanded,
    isExpanded,
    cache,
    planCtx,
  ).lines;
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
  lines,
  scrollOffset,
  visibleRows,
  width,
}: EventLogProps): ReactNode {
  const contentWidth = Math.max(1, width);
  const { start, end } = lineWindow(lines, scrollOffset, visibleRows);
  const visible = lines.slice(start, end);
  const missingRows = Math.max(0, visibleRows - visible.length);

  // Pad above the window so short transcripts sit on the last row of the viewport,
  // flush with the prompt chrome instead of leaving a dead band at the bottom.
  return (
    <Box flexDirection="column">
      {Array.from({ length: missingRows }, (_, i) => renderLine([], `blank-top-${i}`, contentWidth))}
      {visible.map((line, i) => renderLine(line, `line-${start + i}`, contentWidth))}
    </Box>
  );
}
