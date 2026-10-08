/** Transcript stream row model — product-skin styling for real and fake
 * streams (TextRenderable plain, MarkdownRenderable for markdown). */

import { SyntaxStyle } from "@opentui/core";

import { stringWidth, wrapLines } from "./view/height.js";
import type { DiffView } from "./diff.js";
import type { McpStructuredView } from "./mcp-view.js";
import {
  thinkingLivePreviewLines,
  thinkingSettledLine,
  type Thought,
} from "./thinking.js";
import { UI, onThemeChange } from "./theme.js";
import { pastTenseToolLabel } from "./tool-formatter.js";

/** One pre-coloured body line (an expanded call's structured args), painted
 * as authored. */
export type StyledBodyLine = readonly {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
}[];

export type StreamRole = "user" | "assistant" | "tool" | "system";

export interface StreamRow {
  readonly role: StreamRole;
  readonly text: string;
  /** Optional secondary label (tool name, timestamp, etc.). */
  readonly meta?: string;
  /** Force markdown on/off. Only assistant text is authored as markdown;
   * the rest is literal. */
  readonly markdown?: boolean;
  /** Body still being appended; markdown keeps the trailing block
   * unfinalized. */
  readonly streaming?: boolean;
  /** Structured cell grid (MCP record list / detail), painted as a table
   * instead of the raw JSON dump. */
  readonly structured?: McpStructuredView;
  /** Rendered file-edit diff, painted instead of the edit tool's raw JSON
   * arguments. */
  readonly diff?: DiffView;
  /** Tool call errored; a flag so the paint layer marks it without parsing
   * a label. */
  readonly failed?: boolean;
  /** Tool call awaiting its result; the result rewrites the subject in
   * place. */
  readonly pending?: boolean;
  /** Identity of the call a tool row opened; consecutive repeats collapse
   * onto one row. */
  readonly callKey?: string;
  /** Runtime call id this row answers, when the source carried one; a result
   * resolves its row by id, not by tool name. */
  readonly callId?: string;
  /** Id of the queue item this row echoes, so a cancel finds the exact
   * row. */
  readonly queueItemId?: string;
  /** Queued/steered echo cancelled before dispatch; the body stays as
   * typed. */
  readonly cancelled?: boolean;
  /** Delivery settlement for a drained queue/steer row, kept as typed
   * state. */
  readonly deliveryStatus?: "not-delivered" | "uncertain";
  /** Row for a run of repeated calls; the subject stays the repeated call,
   * answers land in the expanded body. */
  readonly coalesced?: boolean;
  /** Calls a coalesced row still awaits — all dispatch before any answer,
   * so the row stays pending until zero. */
  readonly outstanding?: number;
  /** Writer of a non-user row; absent means the session's own agent. */
  readonly agent?: string;
  /** Skill a `use_skill` result loaded; body collapses to a summary until
   * expanded. */
  readonly skill?: string;
  /** Human summary of a tool call's arguments, painted instead of the raw
   * JSON. */
  readonly summary?: string;
  /** Structured body a summarised call reveals when expanded. */
  readonly detail?: readonly StyledBodyLine[];
  /** Settled reasoning: what the row collapses to once thinking is done. */
  readonly thought?: Thought;
  /** Bounded-rate reveal position for a still-streaming reasoning row;
   * absent means show it all. */
  readonly revealChars?: number;
  /** Whether a collapsible body is currently showing in full. */
  readonly expanded?: boolean;
  /** Leading verb of a sentence-style tool row ("Read", "$"); verb +
   * coloured subject instead of the legacy meta column. */
  readonly verb?: string;
  /** Diff stat or line range painted dim after the subject, e.g. "+1/-0". */
  readonly stat?: string;
  /** Raw tool identity of a tool row — the lane grouping key. Always the
   * bare name, unlike `meta`. */
  readonly toolName?: string;
  /** Calls folded into a tool lane; absent or 1 paints the pre-lane
   * single-call row. */
  readonly callCount?: number;
  /** Call ids a lane absorbed (newest appended), so a result resolves its
   * lane by id. */
  readonly memberIds?: readonly string[];
  /** What each absorbed call was about, aligned with `memberIds` —
   * "member — outcome" pairs. */
  readonly memberLabels?: readonly string[];
  /** Most recent result's full text on a coalesced lane — the Alt+C copy
   * source. */
  readonly resultText?: string;
  /** Shell output preview between head and expand hint: up to three tail
   * lines plus the elision marker; never persisted. */
  readonly previewLines?: readonly string[];
  /** Sub-agent row while its worker runs; false once silence looks hung.
   * Absent off the live dispatch path. */
  readonly agentWorking?: boolean;
}

/** What a row needs from the surface: column budget and whether writers
 * need naming. */
export interface RowLayout {
  readonly width: number;
  readonly multiAgent: boolean;
}

/** Writer of a row when none is named: the session's own agent. */
export const MAIN_AGENT = "agent";

/** Expand key; Alt-combined so the prompt cannot swallow it as a typed
 * letter. */
export const EXPAND_KEY = "e";

/** Display label for the transcript/overlay row expand affordance. */
export const EXPAND_HINT_LABEL = "Alt+E";

/** Distinct writers in a transcript. Role labels are worth their columns only above one. */
export function agentVoicesIn(rows: readonly StreamRow[]): ReadonlySet<string> {
  const voices = new Set<string>();
  for (const row of rows) {
    if (row.role === "user") continue;
    voices.add(row.agent ?? MAIN_AGENT);
  }
  return voices;
}

export function isMultiAgent(rows: readonly StreamRow[]): boolean {
  return agentVoicesIn(rows).size > 1;
}

export interface PaintedStreamLine {
  readonly content: string;
  readonly fg: string;
}

/** Transcript rows are text cream; only tool is tinted — machine output in
 * a human conversation. */
const ROLE_FG: Record<StreamRole, string> = {
  user: UI.text,
  assistant: UI.text,
  tool: UI.inFlight,
  system: UI.textDim,
};

/** Diff body palette; the one place orange is not a decision marker. */
export const DIFF_FG = {
  add: UI.done,
  del: UI.action,
  context: UI.textDim,
} as const;

/** Meta column (tool name, `queue`, `error`), fixed so argument and payload
 * line up. */
const META_WIDTH = 12;

/** The mark column carries what colour cannot — failure by cross, operator
 * by bar. */
const MARK_OK = "✓";
const MARK_FAILED = "×";
/** A call still in flight has no verdict yet, and must not borrow one. */
const MARK_PENDING = "·";
/** Sub-agent actively reporting progress — distinct from the bare dot. */
const MARK_AGENT_ACTIVE = "◐";
/** Sub-agent gone quiet past the stall window. */
const MARK_AGENT_STALLED = "!";

/** Single-cell glyphs, so nothing slips out of the meta column (verified
 * by the row-shape tests). */
const BUBBLE_BAR = "▍";
const AGENT_ICON = "●";

/** Blank columns where a per-tool glyph used to sit; keeps the meta column
 * and connector aligned. */
const TOOL_LEAD_GAP = "  ";

/** Thinking is chain-of-thought, not an answer — it paints faintest. */
export function isThinkingRow(row: StreamRow): boolean {
  return row.role === "system" && row.meta === "thinking";
}

function rowFg(row: StreamRow): string {
  if (isThinkingRow(row)) return UI.textFaint;
  // A failed call steps out of the live tool voice; the cross carries the rest.
  if (row.failed === true) return UI.textDim;
  return ROLE_FG[row.role];
}

/** Pad-only; an overlong meta pushes the body rather than truncating — the
 * info outranks the column. */
function fitMeta(meta: string): string {
  return meta.length >= META_WIDTH ? `${meta} ` : meta.padEnd(META_WIDTH);
}

/** Block label above a gap-free run from one writer; repeats only at a
 * writer change. */
export function blockLabel(
  previous: StreamRow | undefined,
  row: StreamRow,
  layout: RowLayout,
): string | null {
  if (!layout.multiAgent || row.role === "user") return null;
  if (previous !== undefined && rowGroupGap(previous, row) === 0) return null;
  return `${AGENT_ICON} ${row.agent ?? MAIN_AGENT}`;
}

/** Where a tool row stands: in flight, answered, or answered badly. */
function toolMark(row: StreamRow): string {
  if (row.failed === true) return MARK_FAILED;
  if (row.pending !== true) return MARK_OK;
  if (row.agentWorking === true) return MARK_AGENT_ACTIVE;
  if (row.agentWorking === false) return MARK_AGENT_STALLED;
  return MARK_PENDING;
}

/** Tool prefix: one mark, then the sentence lead or legacy meta column; a
 * call and its answer share one row. */
function toolPrefix(row: StreamRow): string {
  const mark = toolMark(row);
  if (row.verb !== undefined) return `${mark} `;
  const meta = row.meta && row.meta.length > 0 ? fitMeta(row.meta) : "";
  return `${mark} ${TOOL_LEAD_GAP}${meta}`;
}

/** Columns the operator's bubble may claim before it wraps. */
const BUBBLE_MAX_SHARE = 0.75;

/** Empty bar rows above and below the operator's text so the turn reads as a
 * block. */
const USER_BUBBLE_PAD = 1;

/** Operator turn as a block hugging the left gutter — the bar makes it
 * findable. */
function userBubbleLines(text: string, width: number): string[] {
  const bar = `${BUBBLE_BAR} `;
  const barWidth = stringWidth(bar);
  const body = Math.max(
    1,
    Math.min(width - barWidth, Math.ceil(width * BUBBLE_MAX_SHARE)),
  );
  const lines = text.split("\n").flatMap((line) => wrapLines(line, body));
  const content = lines.map((line) => `${bar}${line}`);
  // Bare bar (no trailing space) so the pad reads as air in the glyph
  // column.
  const pad = BUBBLE_BAR;
  return [
    ...Array.from({ length: USER_BUBBLE_PAD }, () => pad),
    ...content,
    ...Array.from({ length: USER_BUBBLE_PAD }, () => pad),
  ];
}

/** Width a plain row wrapped at, for reassembling URLs split across lines.
 * Keep in sync with userBubbleLines/thinkingLines/indentBody. */
export function plainRowWrapWidth(row: StreamRow, layout: RowLayout): number {
  if (row.role !== "user") return layout.width;
  const barWidth = stringWidth(`${BUBBLE_BAR} `);
  const body = Math.max(
    1,
    Math.min(
      layout.width - barWidth,
      Math.ceil(layout.width * BUBBLE_MAX_SHARE),
    ),
  );
  return body + barWidth;
}

/** Columns a reasoning block is inset by — no marker, so no rail to bind
 * to. */
const THINKING_INDENT = 2;

/** Reasoning laid out as an indented block, for a row with no summary line. */
function thinkingLines(text: string, layout: RowLayout): string[] {
  const lead = " ".repeat(THINKING_INDENT);
  const columns = Math.max(1, layout.width - THINKING_INDENT);
  return text
    .split("\n")
    .flatMap((line) => wrapLines(line, columns))
    .map((line) => `${lead}${line}`);
}

/** Trailer that tells a collapsed row it has more behind it, and how to get there. */
function expandHint(expanded: boolean): string {
  return ` · ${EXPAND_HINT_LABEL} ${expanded ? "collapse" : "expand"}`;
}

/** Arrow affordance of a sentence-style tool row; also the click target
 * that toggles it. */
export const ROW_ARROW = { collapsed: "▸", expanded: "▾" } as const;

/** Small arrow affordance for a sentence-style tool row: absent, ▸, or ▾. */
function toolArrow(row: StreamRow): string {
  if (!isCollapsibleRow(row)) return "";
  return row.expanded === true ? ROW_ARROW.expanded : ROW_ARROW.collapsed;
}

/** A line's trailing arrow split off, or null when it ends in none; a
 * separate renderable so the toggle click lands on the glyph. */
export function splitTrailingArrow(line: StyledBodyLine): {
  readonly body: StyledBodyLine;
  readonly arrow: StyledBodyLine[number];
} | null {
  const last = line[line.length - 1];
  if (last === undefined) return null;
  const glyph = last.text.trim();
  if (glyph !== ROW_ARROW.collapsed && glyph !== ROW_ARROW.expanded)
    return null;
  return { body: line.slice(0, -1), arrow: last };
}

/** Elapsed reasoning time, compact enough to ride a panel's closing tick. */
function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Reasoning body: inset paragraph while streaming; once the turn moves on
 * it collapses to the opening clause, the rest behind the expand key. */
function reasoningLines(row: StreamRow, layout: RowLayout): string[] {
  const lead = " ".repeat(THINKING_INDENT);
  const columns = Math.max(1, layout.width - THINKING_INDENT);
  if (row.streaming === true) {
    return thinkingLivePreviewLines(row.text, columns, row.revealChars).map(
      (line) => `${lead}${line}`,
    );
  }
  if (row.thought === undefined) return thinkingLines(row.text, layout);
  const expanded = row.expanded === true;
  const hint = expandHint(expanded);
  const summary = thinkingSettledLine(
    row.text,
    Math.max(1, columns - stringWidth(hint)),
  );
  const head = `${lead}${summary}${hint}`;
  if (!expanded) return [head];
  // Elapsed time rides the panel, not the summary line.
  const panel = expansionTextPanel(
    row.text,
    expansionColumns(THINKING_INDENT, layout),
    elapsedLabel(row.thought.ms),
  );
  return [head, ...detailPlainLines(panel).map((line) => `${lead}${line}`)];
}

/** Revealed bodies inset past their summary, railed down the left edge,
 * closed by a tick. */
const EXPANSION_INDENT = 2;
const EXPANSION_RAIL = "┆";
const EXPANSION_END = "╵";

const EXPANSION_LEAD = `${" ".repeat(EXPANSION_INDENT)}${EXPANSION_RAIL} `;

/** Columns a revealed body has left after its row prefix and rail. */
export function expansionColumns(
  gutterWidth: number,
  layout: RowLayout,
): number {
  return Math.max(1, layout.width - gutterWidth - stringWidth(EXPANSION_LEAD));
}

/** Revealed content as a detail panel beneath its summary; `trailer` rides
 * the closing tick. */
export function expansionPanel(
  body: readonly StyledBodyLine[],
  trailer?: string,
): StyledBodyLine[] {
  const rail = { text: EXPANSION_LEAD, fg: UI.textFaint };
  const end = `${" ".repeat(EXPANSION_INDENT)}${EXPANSION_END}`;
  const tail = trailer === undefined ? end : `${end} ${trailer}`;
  return [
    ...body.map((line): StyledBodyLine => [rail, ...line]),
    [{ text: tail, fg: UI.textFaint }],
  ];
}

/** Plain revealed text as a panel, wrapped to its columns, painted quieter
 * than the summary. */
export function expansionTextPanel(
  text: string,
  columns: number,
  trailer?: string,
): StyledBodyLine[] {
  const wrapped = text.split("\n").flatMap((line) => wrapLines(line, columns));
  return expansionPanel(
    wrapped.map((line) => [{ text: line, fg: UI.textDim }]),
    trailer,
  );
}

/** Summary a loaded skill collapses to: which skill, and how much it brought. */
function skillSummary(row: StreamRow, skill: string): string {
  const lines = row.text.split("\n").length;
  const summary = `skill "${skill}" loaded · ${lines} line${lines === 1 ? "" : "s"}`;
  return `${summary}${expandHint(row.expanded === true)}`;
}

/** Plain-text rendering of a styled body, for text frames and the clipboard. */
function detailPlainLines(detail: readonly StyledBodyLine[]): string[] {
  return detail.map((line) =>
    line
      .map((segment) => segment.text)
      .join("")
      .trimEnd(),
  );
}

/** The head line of a summarised tool call: what it did, and the way in. */
export function summaryHead(row: StreamRow, summary: string): string {
  return `${summary}${row.detail === undefined ? "" : expandHint(row.expanded === true)}`;
}

/** Whether this row is a summary with its revealed body showing; such rows
 * paint as styled lines. */
export function isExpansionRow(row: StreamRow): boolean {
  if (row.expanded !== true) return false;
  return row.skill !== undefined || row.detail !== undefined;
}

/** Head plus revealed panel for an expanded summary row, or null when
 * nothing reveals. */
export function expandedRowLines(
  row: StreamRow,
  layout: RowLayout,
): StyledBodyLine[] | null {
  if (!isExpansionRow(row)) return null;
  const columns = expansionColumns(
    stringWidth(streamRowGutter(row, layout).content),
    layout,
  );
  if (row.skill !== undefined) {
    return [
      [{ text: skillSummary(row, row.skill), fg: UI.text }],
      ...expansionTextPanel(row.text, columns),
    ];
  }
  return [
    [{ text: summaryHead(row, row.summary ?? ""), fg: UI.text }],
    ...expansionPanel(row.detail ?? []),
  ];
}

/** The text a row paints, after collapsing anything that hides behind a summary. */
function rowBody(row: StreamRow, layout: RowLayout): string {
  const expanded = expandedRowLines(row, layout);
  if (expanded !== null) return detailPlainLines(expanded).join("\n");
  if (row.skill !== undefined) return skillSummary(row, row.skill);
  if (row.summary === undefined) return row.text;
  return summaryHead(row, row.summary);
}

/** Columns a sentence-row's expanded detail/diff is inset by beneath the head. */
const TOOL_DETAIL_INDENT = 2;

/** Continuation line indent for a wrapped `&&`-chained shell command. */
const CHAIN_INDENT = "    ";

/** Cut a subject to its column budget; a wrapped URL would turn a scannable
 * list into a wall. */
function truncateLine(text: string, columns: number): string {
  if (columns <= 0 || stringWidth(text) <= columns) return text;
  let out = "";
  for (const char of text) {
    if (stringWidth(out) + stringWidth(char) > columns - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** A shell command's `&&` chain, one segment per line, connector trailing
 * every line but the last. */
function shellChainSegments(command: string): readonly string[] {
  return command.includes(" && ") ? command.split(" && ") : [command];
}

/** The always-visible head of a sentence-style tool row: verb + coloured
 * subject, dim stat, expand arrow. */
export function toolSentenceLines(
  row: StreamRow,
  columns?: number,
): StyledBodyLine[] {
  const fg = rowFg(row);
  const verb = row.verb ?? "";
  const subject = row.summary ?? row.text;
  // A verb that already names the call has no subject to pair with.
  const laneCount = row.callCount;
  const laneSettled =
    laneCount !== undefined && laneCount > 1 && row.pending !== true;
  // A settled lane rewrites its head to past tense; a pending lane keeps
  // narrating the newest call.
  const head =
    laneSettled && row.toolName !== undefined
      ? `${pastTenseToolLabel(row.toolName)} ×${laneCount} · `
      : verb.length === 0
        ? ""
        : subject.length === 0
          ? verb
          : `${verb} `;
  const chip =
    laneCount !== undefined && laneCount > 1 && row.pending === true
      ? ` · ×${laneCount}`
      : "";
  const stat =
    row.stat !== undefined && row.stat.length > 0 ? ` ${row.stat}` : "";
  // A collapsed row with a shell preview paints the arrow after the preview
  // lines, not on the head.
  const suppressArrow =
    row.previewLines !== undefined &&
    row.previewLines.length > 0 &&
    row.expanded !== true;
  const arrow = suppressArrow ? "" : toolArrow(row);
  // Columns, not code units: the arrow is an ambiguous-width glyph, and this
  // number is subtracted from the same budget `stringWidth(head)` is.
  const arrowWidth = stringWidth(arrow);
  const trailer =
    stringWidth(stat) +
    stringWidth(chip) +
    (arrowWidth > 0 ? arrowWidth + 1 : 0);
  const segments = shellChainSegments(
    columns === undefined || subject.includes(" && ")
      ? subject
      : truncateLine(subject, columns - stringWidth(head) - trailer),
  );
  const lines: StyledBodyLine[] = segments.map((segment, i) => {
    const lead: StyledBodyLine =
      i === 0 ? [{ text: head, fg }] : [{ text: CHAIN_INDENT, fg }];
    const isLast = i === segments.length - 1;
    const body: StyledBodyLine = [{ text: segment, fg: UI.inFlightBright }];
    const chain: StyledBodyLine = isLast
      ? []
      : [{ text: " && \\", fg: UI.textDim }];
    const chipSegment: StyledBodyLine =
      isLast && chip.length > 0 ? [{ text: chip, fg: UI.textDim }] : [];
    return [...lead, ...body, ...chipSegment, ...chain];
  });
  const last = lines[lines.length - 1] ?? [];
  const statSegment = stat.length > 0 ? [{ text: stat, fg: UI.textDim }] : [];
  const arrowSegment =
    arrow.length > 0 ? [{ text: ` ${arrow}`, fg: UI.textDim }] : [];
  lines[lines.length - 1] = [...last, ...statSegment, ...arrowSegment];
  return lines;
}

/** A styled body line, indented by `columns` for a row's expanded detail. */
function indentStyledLine(
  line: StyledBodyLine,
  columns: number,
): StyledBodyLine {
  return [{ text: " ".repeat(columns), fg: UI.text }, ...line];
}

/** Full painted body of a sentence-style tool row: head plus indented
 * detail once expanded. Collapse hides only the tail. */
export function toolRowLines(
  row: StreamRow,
  columns?: number,
): StyledBodyLine[] {
  const head = toolSentenceLines(row, columns);
  if (row.expanded !== true && row.previewLines !== undefined) {
    // Shell settle preview: dim tail lines between the head and the expand
    // arrow, truncated to the columns left beside the indent.
    const preview = row.previewLines;
    const arrow = toolArrow(row);
    return [
      ...head,
      ...preview.map((line, i) => {
        const text =
          columns !== undefined
            ? truncateLine(line, columns - TOOL_DETAIL_INDENT)
            : line;
        const segments: StyledBodyLine =
          i === preview.length - 1 && arrow.length > 0
            ? [
                { text, fg: UI.textDim },
                { text: ` ${arrow}`, fg: UI.textDim },
              ]
            : [{ text, fg: UI.textDim }];
        return indentStyledLine(segments, TOOL_DETAIL_INDENT);
      }),
    ];
  }
  if (row.expanded !== true) return head;
  const tail =
    row.diff !== undefined
      ? row.diff.lines
      : row.detail !== undefined
        ? row.detail
        : [];
  return [
    ...head,
    ...tail.map((line) => indentStyledLine(line, TOOL_DETAIL_INDENT)),
  ];
}

/** Format a stream row for the transcript; bubbles and reasoning blocks are
 * laid out here. */
export function paintStreamRow(
  row: StreamRow,
  layout: RowLayout,
): PaintedStreamLine {
  const fg = rowFg(row);
  if (row.role === "user") {
    // Only settlement state paints onto a queued/steered row itself; row
    // text stays untouched so copy/resume sees the original body.
    const prefix =
      row.cancelled === true
        ? "[cancelled] "
        : row.deliveryStatus === "not-delivered"
          ? "[not delivered] "
          : row.deliveryStatus === "uncertain"
            ? "[delivery uncertain] "
            : row.meta === "reinject"
              ? "[restarted here] "
              : "";
    return {
      content: userBubbleLines(`${prefix}${row.text}`, layout.width).join("\n"),
      fg,
    };
  }
  if (isThinkingRow(row)) {
    return {
      content: reasoningLines(row, layout).join("\n"),
      fg,
    };
  }
  const gutter = streamRowGutter(row, layout).content;
  return {
    content: `${gutter}${indentBody(rowBody(row, layout), gutter, layout)}`,
    fg,
  };
}

/** Wrap a body to the columns left beside its prefix; the renderer alone
 * would break gutter alignment. */
function indentBody(text: string, gutter: string, layout: RowLayout): string {
  const lead = stringWidth(gutter);
  const columns = Math.max(1, layout.width - lead);
  const lines = text.split("\n").flatMap((line) => wrapLines(line, columns));
  return lines.join(`\n${" ".repeat(lead)}`);
}

/** Blank rows painted above a row that opens a new group. */
export const ROW_GROUP_GAP = 1;

/** Writer of a row for gap/grouping purposes; the operator has no writer. */
function gapWriter(row: StreamRow): string | null {
  return row.role === "user" ? null : (row.agent ?? MAIN_AGENT);
}

/** Vertical rhythm between transcript rows: a turn boundary earns a blank
 * row; a thinking row never does (its line must not shift the screen). */
export function rowGroupGap(
  previous: StreamRow | undefined,
  row: StreamRow,
): number {
  if (previous === undefined) return 0;
  // Thinking leads its answer, so the turn's one gap goes below the
  // reasoning line.
  if (isThinkingRow(row)) return 0;
  if (isThinkingRow(previous)) return ROW_GROUP_GAP;
  if (previous.role !== row.role) return ROW_GROUP_GAP;
  // A change of writer is a fresh block even when the role stays the same.
  if (gapWriter(previous) !== gapWriter(row)) return ROW_GROUP_GAP;
  // Same voice, different call: the result stays glued to its call; the next
  // call starts its own block.
  if (row.role === "tool" && (previous.meta ?? "") !== (row.meta ?? "")) {
    return ROW_GROUP_GAP;
  }
  return 0;
}

/** Whether this row's body should render as markdown rather than literal text. */
export function isMarkdownRow(row: StreamRow): boolean {
  if (row.structured !== undefined || row.diff !== undefined) return false;
  if (isDetailRow(row)) return false;
  // A markdown body would re-wrap the operator's bubble out of the right
  // gutter.
  if (row.role === "user") return false;
  return row.markdown ?? row.role === "assistant";
}

/** Whether this row paints a structured table body instead of its text. */
export function isStructuredRow(row: StreamRow): boolean {
  return row.structured !== undefined;
}

/** Whether this row reads as a sentence — verb plus coloured subject, arrow
 * when something is behind it. */
export function isSentenceRow(row: StreamRow): boolean {
  if (row.role !== "tool") return false;
  return row.verb !== undefined || row.summary !== undefined;
}

/** Whether this row paints a diff body instead of its text. */
export function isDiffRow(row: StreamRow): boolean {
  return row.diff !== undefined;
}

/** Whether this row paints a styled structured body (an opened tool call). */
export function isDetailRow(row: StreamRow): boolean {
  return row.detail !== undefined && row.expanded === true;
}

/** Whether the expand key has anything to do on this row: loaded skill,
 * summarised tool call, or settled reasoning. */
export function isCollapsibleRow(row: StreamRow): boolean {
  if (row.skill !== undefined) return true;
  if (row.summary !== undefined && row.detail !== undefined) return true;
  if (row.summary !== undefined && row.structured !== undefined) return true;
  if (row.diff !== undefined) return true;
  return (
    isThinkingRow(row) && row.thought !== undefined && row.streaming !== true
  );
}

/** Prefix beside a body the renderer owns (markdown, table, diff). Empty for
 * a lone agent's prose; writer identity is a block header, not per-row. */
export function streamRowGutter(
  row: StreamRow,
  _layout: RowLayout,
): PaintedStreamLine {
  const fg = rowFg(row);
  if (row.role === "tool") return { content: toolPrefix(row), fg };
  const meta =
    row.meta !== undefined && row.meta.length > 0 && !isThinkingRow(row)
      ? fitMeta(row.meta)
      : "";
  return { content: meta, fg };
}

/** Markdown styling for transcript bodies on the role palette; read from the
 * live `UI` binding so a theme pin rebuilds them. */
function markdownStyles() {
  return {
    default: { fg: UI.text },
    conceal: { fg: UI.textFaint, dim: true },
    // Tree-sitter tags headings by level and SyntaxStyle matches whole scope
    // names, so the bare scope alone would never hit.
    "markup.heading": { fg: UI.heading, bold: true },
    "markup.heading.1": { fg: UI.heading, bold: true },
    "markup.heading.2": { fg: UI.heading, bold: true },
    "markup.heading.3": { fg: UI.heading, bold: true },
    "markup.heading.4": { fg: UI.heading, bold: true },
    "markup.heading.5": { fg: UI.heading, bold: true },
    "markup.heading.6": { fg: UI.heading, bold: true },
    "markup.strong": { fg: UI.text, bold: true },
    "markup.italic": { fg: UI.text, italic: true },
    "markup.strikethrough": { fg: UI.textFaint },
    "markup.raw": { fg: UI.inFlight },
    "markup.list": { fg: UI.inFlightBright },
    "markup.quote": { fg: UI.textDim, italic: true },
    "markup.link": { fg: UI.inFlightBright },
    "markup.link.label": { fg: UI.inFlightBright },
    "markup.link.url": { fg: UI.inFlightBright },
    keyword: { fg: UI.inFlightBright },
    string: { fg: UI.done },
    number: { fg: UI.done },
    comment: { fg: UI.textFaint, italic: true },
    function: { fg: UI.inFlight },
    type: { fg: UI.inFlightBright },
    variable: { fg: UI.text },
    punctuation: { fg: UI.textDim },
  };
}

let cachedSyntaxStyle: SyntaxStyle | null = null;

/** Shared transcript SyntaxStyle, built lazily — the native render lib is
 * unreachable until a renderer exists. */
export function transcriptSyntaxStyle(): SyntaxStyle {
  if (cachedSyntaxStyle === null) {
    cachedSyntaxStyle = SyntaxStyle.fromStyles({ ...markdownStyles() });
  }
  return cachedSyntaxStyle;
}

onThemeChange(() => {
  cachedSyntaxStyle = null;
});
