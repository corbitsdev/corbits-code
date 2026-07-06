import { Box, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import { memo, useMemo, type ReactNode } from "react";
import { parseMarkdown } from "../markdown-parser.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, mergedToolCollapsedPreview, summarizeToolResult } from "../tool-formatter.js";
import { extractMcpRecords, extractMcpRecord } from "../mcp-result-format.js";
import { isMcpToolName } from "../../mcp/tool-name.js";
import { mcpRecordsToView, mcpRecordToView } from "../mcp-view.js";
import { viewToLines, type StyledLine } from "../view/index.js";
import { wrapLines, wrapRanges, stringWidth } from "../view/height.js";
import { color } from "../theme.js";
import { editDiffFromArgs, renderDiff } from "../diff.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "tasks" }>;

export type EventLogProps = {
  lines: StyledLine[];
  scrollOffset: number;
  visibleRows: number;
  width: number;
};

const SHELL_PREFIX = "$ ";
const USER_CODE_BLOCK_LINE_LIMIT = 12;
const EXPANDED_TOOL_RESULT_LINE_LIMIT = 200;
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
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  dimColor?: boolean;
  backgroundColor?: string;
};

function segmentProps(seg: StyledSegment): RenderProps {
  const props: RenderProps = {};
  // Inline emphasis reads as brighter text rather than heavy bold, so a paragraph
  // peppered with **strong** spans stays calm. Structural headings still carry
  // weight through the heading branch below.
  if (seg.bold) props.color = color("emphasis");
  if (seg.italic) props.italic = true;
  if (seg.strikethrough) props.strikethrough = true;
  // Headings read as section anchors through colour alone; adding bold weight on
  // top made the transcript feel heavy, so hue carries the hierarchy.
  if (seg.heading !== undefined) {
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
  // List markers are structure, not signal — keep them quiet so a bulleted
  // message does not read as a wall of accent colour.
  if (seg.bullet && /^\s*(•|\d+\.)/.test(seg.text)) props.color = color("muted");
  // Inline code (paths, identifiers, commands) is reference, not a warning.
  // Loud brand orange on every backtick swamped the transcript; a calm muted
  // tone keeps it distinct from prose without shouting.
  if (seg.code) props.color = color("muted");
  // Explicit per-segment styling (views, shell prefix) wins over flag-derived
  // colours so the one render path serves both markdown and the view spec.
  if (seg.color !== undefined) props.color = seg.color;
  if (seg.dim) props.dimColor = true;
  if (seg.backgroundColor !== undefined) props.backgroundColor = seg.backgroundColor;
  return props;
}

function styleKey(seg: StyledSegment): string {
  return [
    seg.bold ? "b" : "",
    seg.italic ? "i" : "",
    seg.strikethrough ? "s" : "",
    seg.heading ?? "",
    seg.link ? "l" : "",
    seg.blockquote ? "q" : "",
    seg.rule ? "r" : "",
    seg.bullet ? "u" : "",
    seg.code ? "c" : "",
    seg.color ?? "",
    seg.dim ? "d" : "",
    seg.backgroundColor ?? "",
  ].join("\x1f");
}

// Ink lays out and diffs one node per <Text> every frame, so collapsing runs of
// identically styled segments into a single node cuts the per-frame cost of the
// visible window — most visibly on tables, whose padding fragments each row.
function mergeAdjacentSegments(line: StyledLine): StyledSegment[] {
  const out: StyledSegment[] = [];
  let prevKey: string | undefined;
  for (const seg of line) {
    const key = styleKey(seg);
    const last = out[out.length - 1];
    if (last !== undefined && key === prevKey) {
      last.text += seg.text;
    } else {
      out.push({ ...seg });
      prevKey = key;
    }
  }
  return out;
}

type RenderedLineProps = {
  line: StyledLine;
  width: number;
};

const RenderedLine = memo(function RenderedLine({ line, width }: RenderedLineProps): ReactNode {
  const segments = useMemo(() => {
    const textWidth = line.reduce((n, s) => n + stringWidth(s.text), 0);
    const pad = Math.max(0, width - textWidth);
    const padded = pad > 0 ? [...line, { text: " ".repeat(pad) }] : line;
    return mergeAdjacentSegments(padded);
  }, [line, width]);

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} {...segmentProps(seg)}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}, (prev, next) => prev.line === next.line && prev.width === next.width);

function wrapStyledLine(segments: StyledSegment[], width: number): StyledLine[] {
  if (segments.length === 0) return [[]];

  const first = segments[0];
  const markerWidth = first?.bullet === true && /^\s*(?:•|\d+\.)\s+/.test(first.text)
    ? stringWidth(first.text)
    : 0;
  if (first !== undefined && markerWidth > 0) {
    const marker = first;
    const body = segments.slice(1);
    if (body.length === 0) return [segments];
    const bodyText = body.map((s) => s.text).join("");
    const bodyWidth = Math.max(1, width - markerWidth);
    return wrapRanges(bodyText, bodyWidth).map((range, index) => [
      index === 0 ? marker : { text: " ".repeat(markerWidth) },
      ...sliceSegments(body, range.start, range.end),
    ]);
  }

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

// Expanded tool output is tail-anchored to match the ingress cap policy: exit
// codes, error summaries, and test totals live at the end. A small head stub
// keeps enough context to orient the reader before the elision.
function limitLines(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const hidden = lines.length - maxLines;
  const headStub = Math.min(3, maxLines - 1);
  const tailKeep = maxLines - headStub - 1;
  return [
    ...lines.slice(0, headStub),
    `[${hidden} more lines hidden]`,
    ...lines.slice(lines.length - tailKeep),
  ].join("\n");
}

// A static header for the top of the scrollback that lists the skills and
// plugins loaded for this session, so they are visible on load and a scroll-up
// away thereafter. Returns nothing when there is nothing to show.
export function buildResourceBanner(
  skills: readonly { name: string }[],
  plugins: readonly string[],
  width: number,
): StyledLine[] {
  const lines: StyledLine[] = [];
  const section = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    if (lines.length > 0) lines.push([]);
    lines.push([{ text: `[${label}]`, color: color("brand") }]);
    lines.push(...plainLines(items.join(", "), { color: color("muted") }, width));
  };
  section("Skills", skills.map((s) => s.name));
  section("Plugins", plugins);
  if (lines.length > 0) lines.push([]);
  return lines;
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
    const edit = editDiffFromArgs(block.name, block.arguments);
    if (edit !== null) {
      // write_file replaces a whole file, so collapse its unchanged context;
      // edit_file hunks are already small and read best in full.
      const diff = renderDiff(
        edit.oldText,
        edit.newText,
        width,
        block.name === "write_file" ? { contextLines: 3 } : {},
      );
      return [...headline, ...diff];
    }
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

function mergedFileEditGroupLines(count: number, width: number): StyledLine[] {
  return wrapStyledLine(
    [
      { text: "● ", color: color("success"), dim: true },
      { text: `Edited ${count} files`, color: color("muted"), dim: true },
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
    const limited = limitLines(full, EXPANDED_TOOL_RESULT_LINE_LIMIT);
    return isJSONDocument ? markdownLines(limited, width) : plainLines(limited, { color: color("muted") }, width);
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
      // A subtle, neutral-grey box with a blank padded row above and below so the
      // text has breathing room. Text starts at column 1 to line up with the
      // assistant's "●" marker; a 1-col right margin keeps the fill off the edge.
      const bg = "#45454a";
      const LEFT = 1;
      const RIGHT = 1;
      const innerWidth = Math.max(1, width - LEFT - RIGHT);
      const blankRow = [{ text: " ".repeat(width), backgroundColor: bg }];
      const userLines = plainLines(
        compactUserCodeBlocks(block.content),
        { color: color("text"), backgroundColor: bg },
        innerWidth,
      );
      const body = userLines.map((line) => {
        const textLen = line.reduce((n, s) => n + s.text.length, 0);
        const pad = Math.max(0, innerWidth - textLen + RIGHT);
        return [
          { text: " ".repeat(LEFT), backgroundColor: bg },
          ...line,
          { text: " ".repeat(pad), backgroundColor: bg },
        ];
      });
      return [blankRow, ...body, blankRow];
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
      && (block.name === "edit_file" || block.name === "write_file")
      && !isExpanded(block)
    ) {
      let j = i;
      let pairCount = 0;
      while (j + 1 < blocks.length) {
        const call = blocks[j];
        const result = blocks[j + 1];
        if (
          call?.type !== "tool_call"
          || result?.type !== "tool_result"
          || (call.name !== "edit_file" && call.name !== "write_file")
          || result.name !== call.name
          || isExpanded(call)
          || isExpanded(result)
        ) break;
        pairCount++;
        j += 2;
      }
      if (pairCount >= 3) {
        const groupLines = indentLines(
          mergedFileEditGroupLines(pairCount, Math.max(8, columns) - TOOL_INDENT),
          TOOL_INDENT,
        );
        lines.push(...groupLines);
        for (let k = i + 1; k < j; k++) blockLineStarts[k] = lines.length;
        i = j - 1;
        continue;
      }
    }

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

export const DEFAULT_MAX_RENDERED_LOG_LINES = 2000;

export type IncrementalLinesState = {
  blocks: RenderableBlock[];
  lines: StyledLine[];
  blockLineStarts: number[];
  /** Visual line contribution per block index from the last raw assemble (pre-trim). */
  blockRenderLineCounts: number[];
  layoutKey: string;
  firstRenderedBlockIndex: number;
  hiddenRenderedLineCount: number;
};

function blockLineCountsFromStarts(blockLineStarts: number[], lineCount: number): number[] {
  // assembleRenderableBlocks leaves indices below startBlockIndex sparse. Treat
  // any hole as zero-width so downstream sums never see NaN — `??` does not
  // catch NaN once it propagates, so the guard belongs here at the source.
  const counts = new Array<number>(blockLineStarts.length);
  for (let i = 0; i < blockLineStarts.length; i++) {
    const start = blockLineStarts[i] ?? 0;
    const rawNext = i + 1 < blockLineStarts.length ? blockLineStarts[i + 1] : lineCount;
    const next = rawNext ?? start;
    counts[i] = Math.max(0, next - start);
  }
  return counts;
}

function findTailStartFromLineCounts(counts: number[], maxLines: number, markerReserve: number): number {
  const budget = maxLines - markerReserve;
  let accumulated = 0;
  for (let i = counts.length - 1; i >= 0; i--) {
    const count = counts[i] ?? 0;
    if (accumulated + count > budget && i < counts.length - 1) return i + 1;
    accumulated += count;
  }
  return 0;
}

function hiddenLinesMarker(hidden: number): StyledLine {
  return [
    { text: `↑ ${hidden} earlier rendered lines hidden to keep the UI responsive`, dim: true },
  ];
}

function trimBuiltLinesToMax(
  lines: StyledLine[],
  blockLineStarts: number[],
  blocks: RenderableBlock[],
  maxLines: number,
): Pick<IncrementalLinesState, "lines" | "blockLineStarts" | "firstRenderedBlockIndex" | "hiddenRenderedLineCount"> {
  if (lines.length <= maxLines) {
    return {
      lines,
      blockLineStarts,
      firstRenderedBlockIndex: 0,
      hiddenRenderedLineCount: 0,
    };
  }

  const keptLineCount = maxLines - 2;
  const cutAt = lines.length - keptLineCount;
  let firstRenderedBlockIndex = 0;
  for (let i = 0; i < blocks.length; i++) {
    if ((blockLineStarts[i] ?? 0) >= cutAt) {
      firstRenderedBlockIndex = i;
      break;
    }
  }

  const trimmed = [
    hiddenLinesMarker(lines.length - keptLineCount),
    [] satisfies StyledLine,
    ...lines.slice(cutAt),
  ];
  const offset = cutAt - 2;
  const nextStarts = blockLineStarts.map((start, i) =>
    i < firstRenderedBlockIndex ? 0 : Math.max(0, start - offset),
  );

  return {
    lines: trimmed,
    blockLineStarts: nextStarts,
    firstRenderedBlockIndex,
    hiddenRenderedLineCount: lines.length - keptLineCount,
  };
}

function estimateBlockLineCount(
  block: RenderableBlock,
  columns: number,
  expanded: boolean,
  cache?: Map<string, StyledLine[]>,
): number {
  const cached = cache?.get(blockCacheKey(block, columns, expanded));
  if (cached !== undefined) return cached.length;
  if (block.type === "tool_call" || block.type === "tool_result") return 1;
  if (block.type === "view") return 4;
  let chars = 40;
  if (block.type === "user" || block.type === "text" || block.type === "thinking") {
    chars = block.content.length;
  } else if (block.type === "error") {
    chars = block.message.length;
  }
  return Math.max(1, Math.ceil(chars / Math.max(8, columns)));
}

function findColdPathStartIndex(
  blocks: RenderableBlock[],
  columns: number,
  isExpanded: (block: RenderableBlock) => boolean,
  cache: Map<string, StyledLine[]> | undefined,
  maxLines: number,
  knownCounts?: number[],
): number {
  if (knownCounts !== undefined && knownCounts.length === blocks.length) {
    return findTailStartFromLineCounts(knownCounts, maxLines, 4);
  }
  const budget = maxLines - 4;
  let accumulated = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const expanded = isExpanded(block);
    const turnGap = block.type === "user" || block.type === "text" ? 1 : 0;
    const count = estimateBlockLineCount(block, columns, expanded, cache) + turnGap;
    if (accumulated + count > budget && i < blocks.length - 1) return i + 1;
    accumulated += count;
  }
  return 0;
}

export function buildLinesIncremental(
  prev: IncrementalLinesState | undefined,
  contentBlocks: ContentBlock[],
  columns: number,
  thinkingExpanded: boolean,
  isExpanded: (block: RenderableBlock) => boolean,
  cache?: Map<string, StyledLine[]>,
  planCtx?: PlanContext,
  layoutKey?: string,
  maxRenderedLines: number = DEFAULT_MAX_RENDERED_LOG_LINES,
): IncrementalLinesState {
  const blocks = renderableBlocks(contentBlocks).filter((b) => thinkingExpanded || b.type !== "thinking");
  // Prune stale cache entries only when blocks were removed (cache has more
  // entries than active blocks). During streaming only the tail changes, so
  // this skips the O(cache+n) scan on every frame.
  if (cache !== undefined && cache.size > blocks.length) {
    pruneBlockLineCache(cache, blocks);
  }

  const key = layoutKey ?? "";

  let startBlockIndex = 0;
  let prefixLines: StyledLine[] = [];

  const prevTailStart = prev?.firstRenderedBlockIndex ?? 0;

  if (prev !== undefined && prev.layoutKey === key && blocks.length > 0) {
    const sameLength = prev.blocks.length === blocks.length;
    const appendedOnly =
      !sameLength
      && blocks.length === prev.blocks.length + 1
      && blocks.slice(0, -1).every((b, i) => b === prev.blocks[i]);

    if (appendedOnly) {
      startBlockIndex = blocks.length - 1;
      prefixLines = prev.lines;
    } else if (sameLength) {
      let firstDiff = blocks.length;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i] !== prev.blocks[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff < prevTailStart) {
        startBlockIndex = prevTailStart;
        prefixLines = [];
      } else if (firstDiff >= blocks.length - 1) {
        startBlockIndex = firstDiff >= blocks.length ? blocks.length - 1 : firstDiff;
        prefixLines = prev.lines.slice(0, prev.blockLineStarts[startBlockIndex] ?? 0);
      }
    } else if (blocks.length < prev.blocks.length) {
      const dropped = prev.blocks.length - blocks.length;
      const suffixMatches = blocks.every((b, i) => b === prev.blocks[i + dropped]);
      if (suffixMatches) {
        startBlockIndex = Math.max(0, prevTailStart - dropped);
        prefixLines = [];
      }
    }
  }

  if (startBlockIndex === 0 && blocks.length > 60) {
    const knownCounts =
      prev !== undefined
      && prev.layoutKey === key
      && prev.blockRenderLineCounts.length === blocks.length
        ? prev.blockRenderLineCounts
        : undefined;
    const coldStart = findColdPathStartIndex(
      blocks,
      columns,
      isExpanded,
      cache,
      maxRenderedLines,
      knownCounts,
    );
    if (coldStart > 0) {
      startBlockIndex = coldStart;
      prefixLines = [
        [{ text: `↑ ${coldStart} earlier blocks skipped during initial layout to keep the UI responsive`, dim: true }],
        [],
      ];
    }
  }

  const { lines: rawLines, blockLineStarts: rawStarts } = assembleRenderableBlocks({
    blocks,
    columns,
    thinkingExpanded,
    isExpanded,
    ...(cache !== undefined ? { cache } : {}),
    ...(planCtx !== undefined ? { planCtx } : {}),
    startBlockIndex,
    prefixLines,
  });

  let blockLineStarts = rawStarts;
  let lines = rawLines;
  let blockRenderLineCounts = blockLineCountsFromStarts(rawStarts, rawLines.length);

  if (prev !== undefined && startBlockIndex > 0) {
    for (let i = 0; i < startBlockIndex; i++) {
      blockLineStarts[i] = prev.blockLineStarts[i] ?? 0;
      if (i < prev.blockRenderLineCounts.length) {
        const prevCount = prev.blockRenderLineCounts[i];
        if (prevCount !== undefined) blockRenderLineCounts[i] = prevCount;
      }
    }
  }

  const trimmed = trimBuiltLinesToMax(lines, blockLineStarts, blocks, maxRenderedLines);
  lines = trimmed.lines;
  blockLineStarts = trimmed.blockLineStarts;

  return {
    blocks,
    lines,
    blockLineStarts,
    blockRenderLineCounts,
    layoutKey: key,
    firstRenderedBlockIndex: trimmed.firstRenderedBlockIndex,
    hiddenRenderedLineCount: trimmed.hiddenRenderedLineCount,
  };
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

// Memoized so typing in the prompt — which re-renders the App shell on every
// keystroke — does not re-walk the visible window unless the lines, scroll
// position, or viewport actually change.
export const EventLog = memo(function EventLog({
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
      {Array.from({ length: missingRows }, (_, i) => <RenderedLine key={`blank-top-${i}`} line={[]} width={contentWidth} />)}
      {visible.map((line, i) => <RenderedLine key={`line-${start + i}`} line={line} width={contentWidth} />)}
    </Box>
  );
});
