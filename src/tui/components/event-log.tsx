import { Box, Static, Text } from "ink";
import type { ContentBlock } from "../use-stream.js";
import { memo, useMemo, useRef, type ReactNode } from "react";
import { formatElapsed } from "./in-flight-indicator.js";
import { elapsedMsFromAnchor } from "../hooks/use-spinner.js";
import { createMemoizedParseMarkdown } from "../markdown-parser.js";
import { createIncrementalMarkdown } from "../streaming-markdown.js";
import type { StyledSegment } from "../markdown-parser.js";
import { describeToolCall, mergedToolCollapsedPreview, summarizeToolResult, toolGlyph } from "../tool-formatter.js";
import { extractMcpRecords, extractMcpRecord } from "../mcp-result-format.js";
import { isMcpToolName } from "../../mcp/tool-name.js";
import { mcpRecordsToView, mcpRecordToView } from "../mcp-view.js";
import { viewToLines, type StyledLine } from "../view/index.js";
import { wrapLines, wrapRanges, stringWidth } from "../view/height.js";
import { color } from "../theme.js";
import { inkPropsForSegment } from "../styled-segment-props.js";
import { osc8Hyperlink } from "../osc8.js";
import { editDiffFromArgs, renderDiff } from "../diff.js";

export type RenderableBlock = Exclude<ContentBlock, { type: "reply" } | { type: "tasks" }>;

export type EventLogProps = {
  // Frozen history, emitted once into native scrollback via <Static>.
  committedLines: StyledLine[];
  // The dynamic tail re-rendered each frame.
  liveLines: StyledLine[];
  visibleRows: number;
  width: number;
};

const SHELL_PREFIX = "$ ";
const USER_CODE_BLOCK_LINE_LIMIT = 12;
const EXPANDED_TOOL_RESULT_LINE_LIMIT = 200;
// Tool calls and results sit one level below assistant prose so the model's
// text draws the eye and tools read as subordinate actions.
const TOOL_INDENT = 2;

// A pending row bakes no elapsed text, but RunningToolRow appends a live
// ` · <elapsed>` clock outside the wrap budget. Shrink the pending wrap width by
// this reserve so the appended clock never spills past the content column and
// forces Ink to wrap the row onto an extra line. Wide enough for the longest
// realistic hour-form clock (` · 23h 59m 59s`), and RunningToolRow trims the
// rendered clock to this width so it can never exceed the reserved room.
export const RUNNING_ELAPSED_RESERVE = 14;

function formatToolDurationMs(ms: number): string {
  if (ms < 50) return "";
  return ` · ${(ms / 1000).toFixed(1)}s`;
}

type ToolResultBlock = Extract<RenderableBlock, { type: "tool_result" }>;

// A cold assemble calls toolResultForCall once per block, and a linear scan per
// call is O(blocks^2). Index each blocks array once (keyed on its identity, so a
// freshly-built array reindexes and a stale one is collected) and look up in
// O(1). The first matching result per callId wins, matching the old scan.
const toolResultIndexCache = new WeakMap<RenderableBlock[], Map<string, ToolResultBlock>>();

function toolResultIndex(blocks: RenderableBlock[]): Map<string, ToolResultBlock> {
  const cached = toolResultIndexCache.get(blocks);
  if (cached !== undefined) return cached;
  const index = new Map<string, ToolResultBlock>();
  for (const block of blocks) {
    if (block.type === "tool_result" && !index.has(block.callId)) index.set(block.callId, block);
  }
  toolResultIndexCache.set(blocks, index);
  return index;
}

function toolResultForCall(blocks: RenderableBlock[], callId: string): ToolResultBlock | undefined {
  return toolResultIndex(blocks).get(callId);
}
// One-column gutter shared by the transcript, the chrome (header/tasks/status),
// and the prompt-box border, so every left edge lines up at the same column.
export const TEXT_GUTTER = 1;

function indentLines(lines: StyledLine[], spaces: number): StyledLine[] {
  if (spaces <= 0) return lines;
  const pad: StyledSegment = { text: " ".repeat(spaces) };
  return lines.map((line) => [pad, ...line]);
}

// When every segment in a line shares one backgroundColor, the row's trailing
// pad segment should carry it too so the wash reaches the full row width
// instead of stopping at the last painted character.
function uniformBackground(line: StyledLine): string | undefined {
  const first = line[0]?.backgroundColor;
  if (first === undefined) return undefined;
  return line.every((seg) => seg.backgroundColor === first) ? first : undefined;
}

// Tag a pending tool call so the event log paints a static indicator on it.
// Only the two anchor segments carry the marker — the first row's leading
// segment for the pending glyph, the last row's trailing segment for the
// elapsed clock — so a wrapped, multi-row command stays intact: the clock
// lands at the logical end rather than in the middle of the wrapped text.
function markRunningRow(lines: StyledLine[], startedAt: number): StyledLine[] {
  if (lines.length === 0) return lines;
  const lastRow = lines.length - 1;
  return lines.map((line, li) =>
    line.map((seg, si) => {
      const isSpinnerAnchor = li === 0 && si === 0;
      const isElapsedAnchor = li === lastRow && si === line.length - 1;
      return isSpinnerAnchor || isElapsedAnchor ? { ...seg, toolRunningSince: startedAt } : seg;
    }),
  );
}

function runningStartOfLine(line: StyledLine): number | undefined {
  return line[0]?.toolRunningSince ?? line[line.length - 1]?.toolRunningSince;
}

const CACHE_KEY_SEPARATOR = "\x1f";

// Tool-call paint depends on whether a matching result exists (pending tint,
// duration, error). Fold that sibling state into the key so a completed call
// never reuses a pending cache entry.
function blockCacheKey(
  block: RenderableBlock,
  columns: number,
  expanded: boolean,
  allBlocks?: RenderableBlock[],
): string {
  const base = [block.id, String(columns), expanded ? "1" : "0"];
  if (block.type === "tool_call" && allBlocks !== undefined) {
    const result = toolResultForCall(allBlocks, block.callId ?? block.id);
    base.push(
      result === undefined
        ? "p"
        : `d${result.finishedAt ?? 0}${result.isError ? "e" : "o"}`,
    );
  }
  return base.join(CACHE_KEY_SEPARATOR);
}

// When a tool_result is appended after its call was already painted into the
// incremental prefix, walk the prefix back so the call is reassembled and can
// merge / drop · running. Only newly appended results (index >= prevLength)
// trigger a walk-back — completed pairs already in prev stay frozen.
function earliestCallIndexForNewResults(
  blocks: RenderableBlock[],
  fromIndex: number,
  prevLength: number,
): number {
  let earliest = fromIndex;
  for (let i = Math.max(fromIndex, prevLength); i < blocks.length; i++) {
    const block = blocks[i];
    if (block?.type !== "tool_result") continue;
    const callId = block.callId ?? block.id;
    for (let j = 0; j < i; j++) {
      const call = blocks[j];
      if (call?.type === "tool_call" && (call.callId ?? call.id) === callId) {
        if (j < earliest) earliest = j;
        break;
      }
    }
  }
  return earliest;
}

function appendTextToLastLine(lines: StyledLine[], text: string, seg: Partial<StyledSegment> = {}): StyledLine[] {
  if (text.length === 0 || lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), [...last, { text, ...seg }]];
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

function segmentProps(seg: StyledSegment) {
  return inkPropsForSegment(seg);
}

function styleKey(seg: StyledSegment): string {
  return [
    seg.bold ? "b" : "",
    seg.italic ? "i" : "",
    seg.strikethrough ? "s" : "",
    seg.heading ?? "",
    seg.link ? "l" : "",
    // Keep distinct link targets unmerged so OSC 8 sequences do not glue.
    seg.linkUrl ?? "",
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
    const rowBg = uniformBackground(line);
    const padSeg: StyledSegment = { text: " ".repeat(pad), ...(rowBg !== undefined ? { backgroundColor: rowBg } : {}) };
    const padded = pad > 0 ? [...line, padSeg] : line;
    return mergeAdjacentSegments(padded);
  }, [line, width]);

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} {...segmentProps(seg)}>
          {seg.linkUrl !== undefined && seg.linkUrl.length > 0 ? osc8Hyperlink(seg.linkUrl, seg.text) : seg.text}
        </Text>
      ))}
    </Text>
  );
}, (prev, next) => prev.line === next.line && prev.width === next.width);

type RunningToolRowProps = {
  line: StyledLine;
  width: number;
  startedAt: number;
};

// The session's single live spinner lives in the bottom status row
// (InFlightIndicator); a pending transcript row must not animate a second one.
// This glyph is fixed rather than driven by a ticking interval, so the row
// never re-renders on its own — it only repaints when the shared lines change.
const PENDING_GLYPH = "○";

// A pending tool row shows a static "still running" marker — glyph plus
// elapsed-so-far clock — without a repaint interval of its own, since that
// would draw a second animated spinner alongside the status row's.
const RunningToolRow = memo(function RunningToolRow({ line, width, startedAt }: RunningToolRowProps): ReactNode {
  const hasSpinner = line[0]?.toolRunningSince !== undefined;
  const hasElapsed = line[line.length - 1]?.toolRunningSince !== undefined;
  const segments = useMemo(() => {
    // The glyph occupies the indent gutter the anchor seg held (glyph + space),
    // so the headline text keeps its column and the row width stays stable.
    // The glyph and clock replace/extend the anchor segments, which may carry
    // a status-card backgroundColor (pending wash) — preserve it so the wash
    // does not break at the glyph or clock boundary.
    const rowBg = line[0]?.backgroundColor;
    const bgProp = rowBg !== undefined ? { backgroundColor: rowBg } : {};
    const head: StyledLine = hasSpinner
      ? [{ text: `${PENDING_GLYPH} `, color: color("live"), ...bgProp }, ...line.slice(1)]
      : [...line];
    // The clock is the one datum this row exists to show. Trim it to the
    // reserved width so an hour-plus elapsed can never soft-wrap the row.
    const elapsedMs = elapsedMsFromAnchor(startedAt);
    const clock = ` · ${formatElapsed(elapsedMs)}`.slice(0, RUNNING_ELAPSED_RESERVE);
    const composed: StyledLine = hasElapsed
      ? [...head, { text: clock, color: color("text"), ...bgProp }]
      : head;
    const textWidth = composed.reduce((n, s) => n + stringWidth(s.text), 0);
    const pad = Math.max(0, width - textWidth);
    const composedBg = uniformBackground(composed);
    const padSeg: StyledSegment = {
      text: " ".repeat(pad),
      ...(composedBg !== undefined ? { backgroundColor: composedBg } : {}),
    };
    const padded = pad > 0 ? [...composed, padSeg] : composed;
    return mergeAdjacentSegments(padded);
  }, [line, width, hasSpinner, hasElapsed, startedAt]);

  // Truncate rather than wrap: the live clock is appended outside the wrap budget,
  // so on an unreserved wide row (a shell command near full width) it clips at the
  // column edge instead of soft-wrapping onto a second terminal line, which would
  // desync the fixed-row viewport accounting until the tool completes.
  return (
    <Text wrap="truncate">
      {segments.map((seg, i) => (
        <Text key={i} {...segmentProps(seg)}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
});

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

const SESSION_BRAND = "Intercode";
const SESSION_ATTRIBUTION = "Powered by Corbits";

// Static header at the top of the parent-session scrollback: product identity,
// workspace path, then skills/plugins loaded for this session.
export function buildResourceBanner(
  skills: readonly { name: string }[],
  plugins: readonly string[],
  width: number,
  cwd: string,
): StyledLine[] {
  const lines: StyledLine[] = [
    [{ text: SESSION_BRAND, bold: true, color: color("brand") }],
    [{ text: SESSION_ATTRIBUTION, color: color("muted"), dim: true }],
    ...plainLines(cwd, { color: color("muted") }, width),
  ];
  const section = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push([]);
    lines.push([{ text: `[${label}]`, color: color("brand") }]);
    lines.push(...plainLines(items.join(", "), { color: color("muted") }, width));
  };
  section("Skills", skills.map((s) => s.name));
  section("Plugins", plugins);
  lines.push([]);
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

// Shared across all blocks: bounded by createMemoizedParseMarkdown's own LRU
// capacity and cleared by clearMarkdownLineCache alongside the coarser
// per-block line cache (see app.tsx), so it never grows across a session.
const memoizedParseMarkdown = createMemoizedParseMarkdown();

export function clearMarkdownLineCache(): void {
  memoizedParseMarkdown.clear();
}

function markdownLines(content: string, width: number): StyledLine[] {
  return memoizedParseMarkdown(content, width).flatMap((segments) =>
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

// A collapsed shell row is a headline, not a document. Chained multi-line
// commands can span dozens of rows; unclamped, their continuation lines have no
// "$ " anchor and read as detached fragments in the transcript. Show the head,
// mark the rest; Ctrl+O reveals the full command.
const COLLAPSED_SHELL_ROW_LIMIT = 4;

function clampedShellLines(command: string, role: string, width: number): StyledLine[] {
  const all = shellLines(command, role, width);
  if (all.length <= COLLAPSED_SHELL_ROW_LIMIT) return all;
  const shown = all.slice(0, COLLAPSED_SHELL_ROW_LIMIT);
  const last = shown[shown.length - 1]!;
  return [
    ...shown.slice(0, -1),
    [...last, { text: ` … (+${all.length - COLLAPSED_SHELL_ROW_LIMIT} more lines)`, color: color("dim"), dim: true }],
  ];
}

function toolCallLines(
  block: Extract<RenderableBlock, { type: "tool_call" }>,
  width: number,
  expanded: boolean,
  meta?: { pending?: boolean; durationSuffix?: string },
): StyledLine[] {
  const { display, role, summary, full, isShell, glyph } = describeToolCall(block.name, block.arguments);
  const roleColor = color(role);
  // A pending row bakes no duration text; its live spinner and elapsed clock are
  // painted by the running-row component from the startedAt marker instead.
  const durationSuffix = meta?.pending ? "" : (meta?.durationSuffix ?? "");
  // The running-row component appends a live ` · <elapsed>` clock after the baked
  // headline. Shrink the wrap budget by that reserve while pending so the appended
  // clock never spills past the content column and forces Ink onto an extra row.
  // A completed row bakes its own duration and gets the full width back.
  const contentWidth = meta?.pending ? Math.max(8, width - RUNNING_ELAPSED_RESERVE) : width;

  if (isShell) {
    // Shell rows keep the full width: reserving here would push a near-full command
    // past the collapse-row limit and drop command text. Instead the running row
    // renders with truncation, so an appended clock on a wide last row clips rather
    // than soft-wrapping onto a second terminal line and skewing viewport accounting.
    const rows = expanded ? shellLines(full, roleColor, width) : clampedShellLines(summary, roleColor, width);
    return appendTextToLastLine(rows, durationSuffix, { color: color("dim"), dim: true });
  }

  if (expanded) {
    const headline = wrapStyledLine([
      { text: `${glyph} `, color: roleColor },
      { text: `${display}${durationSuffix}`, color: roleColor },
    ], contentWidth);
    const edit = editDiffFromArgs(block.name, block.arguments);
    if (edit !== null) {
      // write_file replaces a whole file, so collapse its unchanged context
      // and number lines from 1. edit_file hunks diff old_string against
      // new_string with no known file offset, so the number gutter stays off
      // rather than showing snippet-relative numbers as if they were real.
      const diff = renderDiff(
        edit.oldText,
        edit.newText,
        width,
        block.name === "write_file" ? { contextLines: 3 } : { lineNumbers: false },
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
      { text: `${glyph} `, color: roleColor, dim: role !== "danger" },
      { text: `${display}${durationSuffix}`, color: collapsedColor, dim: role !== "danger" },
      ...(summary.length > 0 ? [{ text: ` ${summary}`, color: color("dim"), dim: true }] : []),
    ],
    contentWidth,
  );
}

function mergedFileEditGroupLines(count: number, width: number): StyledLine[] {
  return wrapStyledLine(
    [
      { text: `${toolGlyph("edit_file")} `, color: color("success"), dim: true },
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
  const { role, isShell, summary, glyph } = describeToolCall(call.name, call.arguments);
  const merged = mergedToolCollapsedPreview(call.name, call.arguments, result.content, result.isError);
  const roleColor = color(role);

  const durationSuffix = formatToolDurationMs((result.finishedAt ?? call.startedAt ?? 0) - (call.startedAt ?? 0));

  if (isShell && !result.isError) {
    // Command and outcome are recomputed from source rather than re-split out of
    // the merged string — a " → " inside the command or output would corrupt it.
    const outcome = summarizeToolResult(call.name, result.content).preview;
    const suffix = outcome === "(no output)" ? undefined : outcome;
    let rows = clampedShellLines(summary, roleColor, width);
    if (suffix !== undefined && suffix.length > 0) {
      rows = appendTextToLastLine(rows, ` → ${suffix}`, { color: color("dim"), dim: true });
    }
    return appendTextToLastLine(rows, durationSuffix, { color: color("dim"), dim: true });
  }

  const collapsedColor = role === "danger" ? roleColor : color("muted");
  return wrapStyledLine(
    [
      { text: `${glyph} `, color: roleColor, dim: role !== "danger" },
      { text: `${merged}${durationSuffix}`, color: collapsedColor, dim: role !== "danger" },
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

// One cache slot is enough: only the transcript's last text block streams, and
// any content replacement or width change resets it.
const streamingTextLines = createIncrementalMarkdown(markdownLines);

function blockToLines(
  block: RenderableBlock,
  columns: number,
  expanded: boolean,
  thinkingExpanded: boolean,
  planCtx?: PlanContext,
  streaming = false,
  allBlocks?: RenderableBlock[],
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
      // A subtle box with a blank padded row above and below so the text has
      // breathing room. Text starts at column 1 to line up with the assistant's
      // "●" marker; a 1-col right margin keeps the fill off the edge.
      const bg = color("userMessageBg");
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
      const textLines = streaming
        ? streamingTextLines(block.content, width)
        : markdownLines(block.content, width);
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
    case "tool_call": {
      const callId = block.callId ?? block.id;
      const result = allBlocks !== undefined ? toolResultForCall(allBlocks, callId) : undefined;
      const pending = result === undefined;
      const started = block.startedAt ?? 0;
      const finished = result?.finishedAt ?? started;
      const durationSuffix = result !== undefined ? formatToolDurationMs(finished - started) : "";
      const indented = indentLines(
        toolCallLines(block, width - TOOL_INDENT, expanded, {
          pending,
          durationSuffix,
        }),
        TOOL_INDENT,
      );
      const callLines = indented;
      return pending ? markRunningRow(callLines, started) : callLines;
    }
    case "tool_result": {
      const indented = indentLines(toolResultLines(block, columns, width - TOOL_INDENT, expanded), TOOL_INDENT);
      return indented;
    }
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
  let lastWasAction = false;

  for (let i = startBlockIndex; i < blocks.length; i++) {
    blockLineStarts[i] = lines.length;
    const block = blocks[i]!;
    const next = blocks[i + 1];
    const startsTurn = block.type === "user" || block.type === "text";
    const isAction = block.type === "tool_call" || block.type === "tool_result";
    // Insert a blank line before a new turn or before an action group that
    // follows prose. This keeps model text from butting directly into tool
    // headlines (the main source of the "smashed together" complaint).
    // Consecutive actions stay compact (no extra blank between them).
    if ((startsTurn || (isAction && !lastWasAction)) && lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last && last.length > 0) lines.push([]);
    }

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
        lastWasAction = true;
        continue;
      }
    }

    if (
      block.type === "tool_call"
      && next?.type === "tool_result"
      && (next.callId ?? next.id) === (block.callId ?? block.id)
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
      lastWasAction = true;
      continue;
    }

    const expanded = isExpanded(block);
    const isStreaming = i === lastIdx || block.type === "plan";
    let blockLines: StyledLine[];

    if (cache !== undefined && !isStreaming) {
      const key = blockCacheKey(block, columns, expanded, blocks);
      const cached = cache.get(key);
      if (cached !== undefined) {
        blockLines = cached;
      } else {
        blockLines = blockToLines(block, columns, expanded, thinkingExpanded, planCtx, false, blocks);
        cache.set(key, blockLines);
      }
    } else {
      blockLines = blockToLines(block, columns, expanded, thinkingExpanded, planCtx, isStreaming, blocks);
    }
    lines.push(...blockLines);
    lastWasAction = isAction;
  }

  return { lines, blockLineStarts };
}

export type IncrementalLinesState = {
  blocks: RenderableBlock[];
  lines: StyledLine[];
  blockLineStarts: number[];
  /** Visual line contribution per block index from the last raw assemble. */
  blockRenderLineCounts: number[];
  layoutKey: string;
  // The exact ContentBlock[] reference `blocks` was filtered from. The stream
  // state getter reuses its snapshot array reference across content-only
  // mutations (streamed tokens mutate a block in place rather than replacing
  // the array), so an identical reference here means renderableBlocks/filter
  // would recompute an identical result — skip it and reuse `blocks` directly
  // rather than re-walking every block on every streamed token.
  sourceBlocks: ContentBlock[];
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
  // Streamed tokens mutate the trailing block's content in place rather than
  // replacing contentBlocks, so the array reference is stable across a whole
  // burst of token deltas. Reusing prev's filtered result on a reference match
  // skips re-walking every block on every token, which is what kept this
  // O(transcript length) per streamed token instead of O(1).
  const key = layoutKey ?? "";
  const blocks =
    prev !== undefined && prev.sourceBlocks === contentBlocks && prev.layoutKey === key
      ? prev.blocks
      : renderableBlocks(contentBlocks).filter((b) => thinkingExpanded || b.type !== "thinking");
  // Prune stale cache entries only when blocks were removed (cache has more
  // entries than active blocks). During streaming only the tail changes, so
  // this skips the O(cache+n) scan on every frame.
  if (cache !== undefined && cache.size > blocks.length) {
    pruneBlockLineCache(cache, blocks);
  }

  let startBlockIndex = 0;
  let prefixLines: StyledLine[] = [];

  if (prev !== undefined && prev.layoutKey === key && blocks.length > 0) {
    const prevLength = prev.blocks.length;
    const maxPrefix = Math.min(prevLength, blocks.length);
    let commonPrefix = 0;
    while (
      commonPrefix < maxPrefix
      && blocks[commonPrefix] === prev.blocks[commonPrefix]
    ) {
      commonPrefix++;
    }

    if (blocks.length >= prevLength && commonPrefix >= prevLength - 1) {
      // All changes are confined to prev's last block (the one that was
      // streaming) and any number of appended blocks — covers a drain that
      // both grew the streaming block and delivered new tool blocks. When the
      // arrays are identical, the last block is still reassembled so the
      // streaming path stays uncached.
      startBlockIndex =
        commonPrefix === blocks.length ? blocks.length - 1 : Math.min(commonPrefix, blocks.length - 1);
      // A newly arrived tool_result still shares object identity with its
      // earlier tool_call. Pull the assemble window back so the call is not
      // left frozen as · running in the prefix.
      startBlockIndex = earliestCallIndexForNewResults(blocks, startBlockIndex, prevLength);
      prefixLines =
        startBlockIndex === prevLength
          ? prev.lines
          : prev.lines.slice(0, prev.blockLineStarts[startBlockIndex] ?? 0);
    }
    // A front-trim (blocks.length < prevLength) or a diverged prefix falls
    // through to a full reassemble from block 0; committed scrollback already
    // owns the dropped history, so nothing is lost by rebuilding the live tail.
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

  const blockLineStarts = rawStarts;
  const lines = rawLines;
  const blockRenderLineCounts = blockLineCountsFromStarts(rawStarts, rawLines.length);

  if (prev !== undefined && startBlockIndex > 0) {
    for (let i = 0; i < startBlockIndex; i++) {
      blockLineStarts[i] = prev.blockLineStarts[i] ?? 0;
      if (i < prev.blockRenderLineCounts.length) {
        const prevCount = prev.blockRenderLineCounts[i];
        if (prevCount !== undefined) blockRenderLineCounts[i] = prevCount;
      }
    }
  }

  return {
    blocks,
    lines,
    blockLineStarts,
    blockRenderLineCounts,
    layoutKey: key,
    sourceBlocks: contentBlocks,
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


function isFileEditTool(name: string): boolean {
  return name === "edit_file" || name === "write_file";
}

/** Adjacent call+result with matching name — same rule as the merge assembler. */
function isAdjacentToolPair(
  call: RenderableBlock,
  result: RenderableBlock,
): boolean {
  return call.type === "tool_call"
    && result.type === "tool_result"
    && result.name === call.name;
}

/**
 * Recover zero-width partners: paired results, and whole file-edit groups (≥3 pairs).
 * Mutates `ids` in place.
 */
function recoverCollapsedPartners(
  blocks: readonly RenderableBlock[],
  ids: Set<string>,
): void {
  for (let i = 0; i < blocks.length - 1; i++) {
    const call = blocks[i]!;
    const result = blocks[i + 1]!;
    if (!isAdjacentToolPair(call, result)) continue;
    if (ids.has(call.id)) ids.add(result.id);
    else if (ids.has(result.id)) ids.add(call.id);
  }

  // Collapsed file-edit groups (≥3 pairs) draw one summary on the first call and
  // leave every other block zero-width. Expand the whole group when any member hits.
  for (let i = 0; i < blocks.length; ) {
    const head = blocks[i]!;
    if (head.type !== "tool_call" || !isFileEditTool(head.name)) {
      i++;
      continue;
    }
    let j = i;
    let pairCount = 0;
    const groupIds: string[] = [];
    while (j + 1 < blocks.length) {
      const call = blocks[j]!;
      const result = blocks[j + 1]!;
      if (call.type !== "tool_call" || !isAdjacentToolPair(call, result) || !isFileEditTool(call.name)) break;
      groupIds.push(call.id, result.id);
      pairCount++;
      j += 2;
    }
    if (pairCount >= 3 && groupIds.some((id) => ids.has(id))) {
      for (const id of groupIds) ids.add(id);
    }
    i = j > i ? j : i + 1;
  }
}

/**
 * Map a line window onto tool block ids in the same line space as `blockLineStarts`.
 * Callers must pass metrics from the layout that produced the scroll offset
 * (display layout while verbose) so membership tracks what is on screen.
 *
 * Zero-width slots left by collapsed merges are recovered:
 * - adjacent tool call/result pairs (same name) expand together
 * - collapsed file-edit groups (≥3 pairs) expand as a whole when any member hits
 */
export function blockIdsInLineRange(
  blocks: readonly RenderableBlock[],
  blockLineStarts: readonly number[],
  lineCount: number,
  lineStart: number,
  lineEnd: number,
): Set<string> {
  const ids = new Set<string>();
  if (blocks.length === 0 || lineEnd <= lineStart) return ids;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== "tool_call" && block.type !== "tool_result") continue;
    const start = blockLineStarts[i] ?? 0;
    const rawNext = i + 1 < blockLineStarts.length ? blockLineStarts[i + 1] : lineCount;
    const end = rawNext ?? start;
    if (end > lineStart && start < lineEnd) {
      ids.add(block.id);
    }
  }

  recoverCollapsedPartners(blocks, ids);
  return ids;
}

/** Hard cap on tool_call blocks expanded by Ctrl+O for one viewport. */
export const DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS = 12;

export type ViewportToolIdsArgs = {
  blocks: readonly RenderableBlock[];
  blockLineStarts: readonly number[];
  lineCount: number;
  prefixLineCount: number;
  visibleRows: number;
  scrollOffset: number;
  atBottom: boolean;
  /** Extra lines above/below the visible window (defaults to one screen). */
  bufferRows?: number;
};

function contentWindowRange(args: {
  prefixLineCount: number;
  lineCount: number;
  visibleRows: number;
  scrollOffset: number;
  atBottom: boolean;
  bufferRows: number;
}): { lineStart: number; lineEnd: number; contentCenter: number } {
  const visibleRows = Math.max(1, args.visibleRows);
  const buffer = Math.max(0, args.bufferRows);
  const total = args.prefixLineCount + args.lineCount;
  const maxOff = Math.max(0, total - visibleRows);
  const windowStart = args.atBottom
    ? maxOff
    : Math.min(Math.max(0, args.scrollOffset), maxOff);
  const windowEnd = windowStart + visibleRows;
  const lineStart = Math.max(0, windowStart - args.prefixLineCount - buffer);
  const lineEnd = Math.max(0, windowEnd - args.prefixLineCount + buffer);
  const contentCenter = Math.max(
    0,
    (windowStart + windowEnd) / 2 - args.prefixLineCount,
  );
  return { lineStart, lineEnd, contentCenter };
}

/**
 * Tools intersecting the visible window (± buffer) in the given layout's line space.
 * `scrollOffset` / `atBottom` must come from the same layout as `lineCount`.
 */
export function viewportToolIds(args: ViewportToolIdsArgs): Set<string> {
  const visibleRows = Math.max(1, args.visibleRows);
  const buffer = Math.max(0, args.bufferRows ?? visibleRows);
  const { lineStart, lineEnd } = contentWindowRange({
    prefixLineCount: args.prefixLineCount,
    lineCount: args.lineCount,
    visibleRows,
    scrollOffset: args.scrollOffset,
    atBottom: args.atBottom,
    bufferRows: buffer,
  });
  return blockIdsInLineRange(
    args.blocks,
    args.blockLineStarts,
    args.lineCount,
    lineStart,
    lineEnd,
  );
}

/**
 * Prefer tools closest to the viewport center when the raw set is denser than the
 * hang-safe budget. Keeps paired results and file-edit groups intact after the cut.
 */
export function capViewportToolIds(
  ids: ReadonlySet<string>,
  blocks: readonly RenderableBlock[],
  blockLineStarts: readonly number[],
  lineCount: number,
  contentCenter: number,
  maxToolCalls: number = DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS,
): Set<string> {
  if (ids.size === 0 || maxToolCalls <= 0) return new Set();

  const scored: { id: string; dist: number }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== "tool_call" || !ids.has(block.id)) continue;
    const start = blockLineStarts[i] ?? 0;
    const rawNext = i + 1 < blockLineStarts.length ? blockLineStarts[i + 1] : lineCount;
    const end = rawNext ?? start;
    const mid = end > start ? (start + end) / 2 : start;
    scored.push({ id: block.id, dist: Math.abs(mid - contentCenter) });
  }

  if (scored.length <= maxToolCalls) {
    return new Set(ids);
  }

  scored.sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));
  const kept = new Set<string>();
  for (let i = 0; i < maxToolCalls; i++) kept.add(scored[i]!.id);
  recoverCollapsedPartners(blocks, kept);
  return kept;
}

export type ResolveViewportExpandIdsArgs = ViewportToolIdsArgs & {
  previousIds?: ReadonlySet<string>;
  /** Buffer for entering the expand set (defaults to one screen). */
  enterBufferRows?: number;
  /** Buffer for staying expanded once entered (defaults to two screens). */
  holdBufferRows?: number;
  maxToolCalls?: number;
};

/**
 * Sticky viewport membership: tools enter at the enter buffer, stay expanded
 * until they leave the hold buffer, then drop. Caps density near the viewport
 * center so a tool-packed screen cannot expand unbounded.
 */
export function resolveViewportExpandIds(args: ResolveViewportExpandIdsArgs): Set<string> {
  const visibleRows = Math.max(1, args.visibleRows);
  const enterBuffer = Math.max(0, args.enterBufferRows ?? visibleRows);
  const holdBuffer = Math.max(enterBuffer, args.holdBufferRows ?? visibleRows * 2);
  const maxToolCalls = args.maxToolCalls ?? DEFAULT_MAX_VIEWPORT_EXPAND_TOOL_CALLS;
  const previous = args.previousIds ?? new Set<string>();

  const enter = viewportToolIds({ ...args, bufferRows: enterBuffer });
  const hold = holdBuffer === enterBuffer
    ? enter
    : viewportToolIds({ ...args, bufferRows: holdBuffer });

  const sticky = new Set(enter);
  for (const id of previous) {
    if (hold.has(id)) sticky.add(id);
  }

  const { contentCenter } = contentWindowRange({
    prefixLineCount: args.prefixLineCount,
    lineCount: args.lineCount,
    visibleRows,
    scrollOffset: args.scrollOffset,
    atBottom: args.atBottom,
    bufferRows: 0,
  });

  return capViewportToolIds(
    sticky,
    args.blocks,
    args.blockLineStarts,
    args.lineCount,
    contentCenter,
    maxToolCalls,
  );
}

// A committed line carries its own identity so Ink's <Static> writes it to
// native scrollback exactly once. Frozen lines never animate, so a committed
// running-tool anchor renders as a plain row.
type CommittedLine = { key: string; line: StyledLine };

const CommittedRow = memo(function CommittedRow({ line, width }: RenderedLineProps): ReactNode {
  return <RenderedLine line={line} width={width} />;
}, (prev, next) => prev.line === next.line && prev.width === next.width);

// The transcript is rendered as two regions. Committed history is handed to Ink's
// <Static>, which emits each line once into the terminal's native scrollback and
// never repaints it — so native scroll, copy/paste, and find operate on it. The
// live region (the streaming tail plus recent turns) renders in Ink's dynamic
// tree, which diffs against the previous frame and rewrites only changed lines.
export const EventLog = memo(function EventLog({
  committedLines,
  liveLines,
  visibleRows,
  width,
}: EventLogProps): ReactNode {
  const contentWidth = Math.max(1, width);
  // committedLines is append-only within a mount (a session reset remounts this
  // component via its epoch key) and grows in place, so its reference is stable
  // across commits. Extend the keyed item list by the newly settled tail instead
  // of re-wrapping the whole frozen history each commit. <Static> keys off the
  // array reference to emit new items, so hand it a fresh reference only when the
  // length grew — the existing wrapper objects are reused, which is the O(n)
  // re-map this incremental path exists to avoid.
  const committedItemsRef = useRef<CommittedLine[]>([]);
  const prevItems = committedItemsRef.current;
  let committed = prevItems;
  if (committedLines.length !== prevItems.length) {
    committed = committedLines.length < prevItems.length
      ? committedLines.map((line, i) => ({ key: `c-${i}`, line }))
      : prevItems.slice();
    for (let i = committed.length; i < committedLines.length; i++) {
      committed.push({ key: `c-${i}`, line: committedLines[i]! });
    }
    committedItemsRef.current = committed;
  }
  const missingRows = Math.max(0, visibleRows - liveLines.length);

  // Pad above the live region so a short tail sits on the last rows of the
  // viewport, flush with the prompt chrome instead of leaving a dead band.
  return (
    <>
      <Static items={committed}>
        {(item) => <CommittedRow key={item.key} line={item.line} width={contentWidth} />}
      </Static>
      <Box flexDirection="column">
        {Array.from({ length: missingRows }, (_, i) => <RenderedLine key={`blank-top-${i}`} line={[]} width={contentWidth} />)}
        {liveLines.map((line, i) => {
          const startedAt = runningStartOfLine(line);
          return startedAt !== undefined
            ? <RunningToolRow key={`line-${i}`} line={line} width={contentWidth} startedAt={startedAt} />
            : <RenderedLine key={`line-${i}`} line={line} width={contentWidth} />;
        })}
      </Box>
    </>
  );
});
