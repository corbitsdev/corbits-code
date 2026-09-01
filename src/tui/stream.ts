/**
 * Transcript stream row model — product skin styling for fake / real streams.
 * Plain rows paint via TextRenderable; markdown-bearing rows via MarkdownRenderable.
 */

import { SyntaxStyle } from "@opentui/core";

import { stringWidth, wrapLines } from "./view/height.js";
import type { DiffView } from "./diff.js";
import type { McpStructuredView } from "./mcp-view.js";
import { thinkingLivePreviewLines, thinkingSettledLine, type Thought } from "./thinking.js";
import { UI } from "./theme.js";

/**
 * One line of a pre-coloured body (an expanded tool call's structured
 * arguments). Styled runs are painted as authored rather than re-parsed, so a
 * body that already knows its own colours keeps them.
 */
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
  /**
   * Force markdown on/off for this row. Defaults by role: only assistant
   * text is authored as markdown — tool output, user echo and system chrome
   * are literal and must not be reflowed or have markers concealed.
   */
  readonly markdown?: boolean;
  /**
   * Row body is still being appended to. Markdown rows keep their trailing
   * block unstable so a half-received fence/table is not finalized early.
   */
  readonly streaming?: boolean;
  /**
   * Structured cell grid (MCP record list / record detail). Painted as a table
   * instead of the row body, which would otherwise be a raw JSON dump.
   */
  readonly structured?: McpStructuredView;
  /**
   * Rendered file-edit diff. Painted instead of the row body, which would
   * otherwise be the edit tool's raw JSON arguments.
   */
  readonly diff?: DiffView;
  /**
   * Tool call that came back an error. Carried as a flag rather than baked
   * into `meta` so the paint layer can mark the row without parsing a label.
   */
  readonly failed?: boolean;
  /**
   * Tool call whose result has not landed yet. The row is the call itself
   * until then; the result resolves the marker and rewrites the subject in
   * place rather than opening a row of its own.
   */
  readonly pending?: boolean;
  /**
   * Identity of the call a tool row opened — tool name plus the sentence it
   * paints. A run of consecutive calls sharing one is a repeat, and collapses
   * onto a single row.
   */
  readonly callKey?: string;
  /**
   * Runtime id of the call this row answers, when the source carried one
   * (a live reactor callId, a resumed transcript's saved id). A result finds
   * the exact row it resolves by this id first — the tool name alone is
   * ambiguous the moment two calls to the same tool are in flight at once,
   * which parallel sub-agent dispatch does on every turn that fires more
   * than one `spawn_agent` call.
   */
  readonly callId?: string;
  /**
   * Id of the queue item this row echoes (see `SessionQueueState`). Lets a
   * cancel find the exact row a queued/steered message appended, rather than
   * guessing by position once other rows have interleaved.
   */
  readonly queueItemId?: string;
  /**
   * The queued/steered message this row echoed was cancelled before it
   * dispatched. Kept as a flag rather than baked into `text` so the stored
   * body stays what the operator actually typed — the paint layer alone
   * decides how a cancelled row reads.
   */
  readonly cancelled?: boolean;
  /**
   * Row standing for a run of repeated calls. Its subject stays the call the
   * run repeats (never a total across them, which would be a claim the
   * payloads do not support); each answer lands in the expanded body.
   */
  readonly coalesced?: boolean;
  /**
   * Calls a coalesced row still awaits. A batch dispatches every call before
   * any answer lands, so the run row cannot settle on its first result — it
   * stays pending until this reaches zero, or the answers still in flight
   * would find no row to fold into.
   */
  readonly outstanding?: number;
  /**
   * Writer of a non-user row. Absent means the session's own agent; the paint
   * layer names writers only once a transcript carries more than one.
   */
  readonly agent?: string;
  /**
   * Name of the skill a `use_skill` result loaded. Present only on rows whose
   * body is skill instructions, which collapse to a summary until expanded.
   */
  readonly skill?: string;
  /**
   * Human summary of a tool call's arguments. Present means the row paints the
   * summary instead of `text`, which is the raw argument JSON.
   */
  readonly summary?: string;
  /** Structured body a summarised call reveals when expanded. */
  readonly detail?: readonly StyledBodyLine[];
  /** Settled reasoning: what the row collapses to once thinking is done. */
  readonly thought?: Thought;
  /**
   * Bounded-rate reveal position for a still-streaming reasoning row — how far
   * into `text` the scroll line is allowed to show. Absent means show it all
   * (a settled row, a hydrated transcript, a fixture with no clock driving it).
   */
  readonly revealChars?: number;
  /** Whether a collapsible body is currently showing in full. */
  readonly expanded?: boolean;
  /**
   * Leading verb of a tool row read as a sentence ("Read", "Created", "$" for
   * a shell command). Present means the row paints verb + coloured subject
   * (`summary`) instead of the legacy meta-column layout.
   */
  readonly verb?: string;
  /** Diff stat or line range painted dim after the subject, e.g. "+1/-0". */
  readonly stat?: string;
  /**
   * A dispatched sub-agent's row while its worker is still running: true
   * once it has reported activity within the stall window, false once the
   * silence has run long enough to look hung rather than merely slow. Absent
   * for every row that is not a live sub-agent dispatch.
   */
  readonly agentWorking?: boolean;
}

/**
 * What a row needs to know about the surface it paints onto: the transcript's
 * column budget (right-aligned bubbles and wrapped bodies are computed, not
 * delegated to the renderer) and whether writers have to be named at all.
 */
export interface RowLayout {
  readonly width: number;
  readonly multiAgent: boolean;
}

/** Writer of a row when none is named: the session's own agent. */
export const MAIN_AGENT = "agent";

/**
 * Key name that expands a collapsed body — combined with Alt in the
 * transcript so the prompt (which almost always holds focus) can never
 * swallow it as a typed letter. The approval overlay's own collapsed
 * payloads answer to the same key name but stay bare there: that overlay is
 * modal and the prompt cannot have focus while it is open.
 */
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

/**
 * Transcript rows are text, so they take the element cream. Only the tool role
 * is tinted — it is machine output threaded through a human conversation, and
 * the bronze separates it without adding a second voice.
 */
const ROLE_FG: Record<StreamRole, string> = {
  user: UI.text,
  assistant: UI.text,
  tool: UI.inFlight,
  system: UI.textDim,
};

/**
 * Diff body palette. This is the one place orange is not the decision marker:
 * a diff is content, and add/remove is the brand's own green/orange pair.
 */
export const DIFF_FG = {
  add: UI.done,
  del: UI.action,
  context: UI.textDim,
} as const;

/**
 * Meta column (tool name, `queue`, `error`). Fixed so a tool call's argument
 * and a tool result's payload start on the same column and can be scanned as
 * one list rather than a ragged log.
 */
const META_WIDTH = 12;

/**
 * The mark column carries what colour is not allowed to: cream is shared by the
 * user and the agent (three-accent limit), so a failed tool call is found by
 * its cross and the operator's own turn by its bubble bar.
 */
const MARK_OK = "✓";
const MARK_FAILED = "×";
/** A call still in flight has no verdict yet, and must not borrow one. */
const MARK_PENDING = "·";
/** A dispatched sub-agent actively reporting progress — distinct from the bare dot. */
const MARK_AGENT_ACTIVE = "◐";
/** A dispatched sub-agent gone quiet past the stall window. */
const MARK_AGENT_STALLED = "!";

/**
 * Glyphs are single-cell so nothing after them can slip out of the meta column.
 * Every one is verified against `stringWidth` by the row-shape tests.
 */
const BUBBLE_BAR = "▍";
const AGENT_ICON = "●";

/**
 * Blank columns where a per-tool-family glyph used to sit. A tool row leads
 * with one success/failure marker now (not a glyph column keyed off tool
 * type), but the width is kept so the meta column and the result connector
 * beneath it still land on the same column.
 */
const TOOL_LEAD_GAP = "  ";

/** Thinking is coalesced chain-of-thought, not an answer — it paints faintest. */
export function isThinkingRow(row: StreamRow): boolean {
  return row.role === "system" && row.meta === "thinking";
}

function rowFg(row: StreamRow): string {
  if (isThinkingRow(row)) return UI.textFaint;
  // A failed call steps out of the live tool voice; the cross carries the rest.
  if (row.failed === true) return UI.textDim;
  return ROLE_FG[row.role];
}

/**
 * Pad-only: a meta longer than the column (an edit summary carries its path and
 * line counts) pushes the body rather than being truncated. Losing the column
 * on those rows costs less than losing the information.
 */
function fitMeta(meta: string): string {
  return meta.length >= META_WIDTH ? `${meta} ` : meta.padEnd(META_WIDTH);
}

/**
 * Block label shown once above the first row of a run of consecutive rows
 * from the same writer. `rowGroupGap` already treats a change of writer (or
 * role) as a turn boundary, so a block is exactly a gap-free run and needs no
 * separate bookkeeping: the label repeats only where the gap does.
 */
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

/**
 * Tool prefix: a single in-flight/success/failure mark, then either the
 * sentence-row's bare lead (verb + coloured subject follow in the body) or the
 * legacy meta column. A call and its answer share one row, so there is no
 * continuation to mark. Writer identity is painted once per block (see
 * `blockLabel`), not repeated on every row.
 */
function toolPrefix(row: StreamRow): string {
  const mark = toolMark(row);
  if (row.verb !== undefined) return `${mark} `;
  const meta = row.meta && row.meta.length > 0 ? fitMeta(row.meta) : "";
  return `${mark} ${TOOL_LEAD_GAP}${meta}`;
}

/** Columns the operator's bubble may claim before it wraps. */
const BUBBLE_MAX_SHARE = 0.75;

/**
 * Empty bar rows painted above and below the operator's text so the turn
 * reads as a block when scrolling past denser assistant/tool rows (CL-5603).
 */
const USER_BUBBLE_PAD = 1;

/**
 * The operator's turn as a block hugging the left gutter, same as an answer,
 * with the bar down its left edge. The bar (not alignment) is what makes a
 * user turn findable now that both voices share cream and the left edge; the
 * body sits two columns past it so the boundary reads even at a glance.
 * One empty bar row above and below the text gives the bubble breathing room
 * without changing the turn-boundary gap used by every other row.
 */
function userBubbleLines(text: string, width: number): string[] {
  const bar = `${BUBBLE_BAR} `;
  const barWidth = stringWidth(bar);
  const body = Math.max(1, Math.min(width - barWidth, Math.ceil(width * BUBBLE_MAX_SHARE)));
  const lines = text.split("\n").flatMap((line) => wrapLines(line, body));
  const content = lines.map((line) => `${bar}${line}`);
  // Bare bar (no trailing body space) so the pad reads as air, not an empty
  // content column — same glyph column as the body lines either way.
  const pad = BUBBLE_BAR;
  return [
    ...Array.from({ length: USER_BUBBLE_PAD }, () => pad),
    ...content,
    ...Array.from({ length: USER_BUBBLE_PAD }, () => pad),
  ];
}

/**
 * Columns a reasoning block is inset by. The inset plus the faintest text in
 * the palette is the whole of reasoning's chrome — it carries no marker of its
 * own, because a rail is a line of noise attached to the quietest thing on the
 * screen and there is nothing above it for the rail to bind it to.
 */
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

/**
 * Arrow affordance of a sentence-style tool row. It is a hit target as well as
 * a glyph — a click on it toggles that one row — so the paint layer needs to
 * find it back in a finished line rather than re-deriving where it landed.
 */
export const ROW_ARROW = { collapsed: "▸", expanded: "▾" } as const;

/** Small arrow affordance for a sentence-style tool row: absent, ▸, or ▾. */
function toolArrow(row: StreamRow): string {
  if (!isCollapsibleRow(row)) return "";
  return row.expanded === true ? ROW_ARROW.expanded : ROW_ARROW.collapsed;
}

/**
 * A line's trailing arrow split off from the rest of it, or null when the line
 * does not end in one. The arrow becomes its own renderable so the click that
 * toggles a row lands on the glyph and nowhere else: rows are text people
 * select and copy, and a whole-row hit target would toggle under every drag.
 */
export function splitTrailingArrow(
  line: StyledBodyLine,
): { readonly body: StyledBodyLine; readonly arrow: StyledBodyLine[number] } | null {
  const last = line[line.length - 1];
  if (last === undefined) return null;
  const glyph = last.text.trim();
  if (glyph !== ROW_ARROW.collapsed && glyph !== ROW_ARROW.expanded) return null;
  return { body: line.slice(0, -1), arrow: last };
}

/** Elapsed reasoning time, compact enough to ride a panel's closing tick. */
function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Reasoning body. While text arrives it wraps into a bounded inset paragraph of
 * the newest revealed prose (no sideways scroll; hard line cap). Once the turn
 * moves on it collapses to the opening clause; the rest is behind the expand
 * key.
 *
 * A row with no settled thought (a hydrated transcript, a fixture) has no
 * summary to collapse to and keeps the plain block.
 */
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
  const summary = thinkingSettledLine(row.text, Math.max(1, columns - stringWidth(hint)));
  const head = `${lead}${summary}${hint}`;
  if (!expanded) return [head];
  // Elapsed time lives here rather than on the summary line: it is worth
  // knowing after the fact, and never worth displacing the reasoning itself.
  const panel = expansionTextPanel(
    row.text,
    expansionColumns(THINKING_INDENT, layout),
    elapsedLabel(row.thought.ms),
  );
  return [head, ...detailPlainLines(panel).map((line) => `${lead}${line}`)];
}

/**
 * Revealed bodies are inset past the summary that revealed them, railed down
 * their left edge, and closed by a tick. The rail earns its columns here in a
 * way it does not on an always-visible reasoning line: it binds content that
 * only exists because of the row above it, and it gives the closing tick
 * something to close.
 */
const EXPANSION_INDENT = 2;
const EXPANSION_RAIL = "┆";
const EXPANSION_END = "╵";

const EXPANSION_LEAD = `${" ".repeat(EXPANSION_INDENT)}${EXPANSION_RAIL} `;

/** Columns a revealed body has left once its row prefix and rail are paid for. */
export function expansionColumns(gutterWidth: number, layout: RowLayout): number {
  return Math.max(1, layout.width - gutterWidth - stringWidth(EXPANSION_LEAD));
}

/**
 * Revealed content as a detail panel beneath its summary. Lines arrive already
 * laid out and keep whatever colours they were authored with. `trailer` rides
 * the closing tick, for the one fact worth knowing about a panel only after
 * having read it.
 */
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

/**
 * Plain revealed text as a panel: wrapped to the columns the panel actually
 * owns, and painted quieter than the summary that revealed it.
 */
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

/**
 * Whether this row is a summary with its revealed body showing. Such rows
 * paint as styled lines (the panel is quieter than its summary), which a
 * single-colour text node cannot express.
 */
export function isExpansionRow(row: StreamRow): boolean {
  if (row.expanded !== true) return false;
  return row.skill !== undefined || row.detail !== undefined;
}

/**
 * Head plus revealed panel for an expanded summary row, or null when the row
 * reveals nothing. One layout for both kinds of revealed body — a loaded
 * skill's instructions and a tool call's structured arguments.
 */
export function expandedRowLines(row: StreamRow, layout: RowLayout): StyledBodyLine[] | null {
  if (!isExpansionRow(row)) return null;
  const columns = expansionColumns(stringWidth(streamRowGutter(row, layout).content), layout);
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

/**
 * Cut a subject to the columns it may claim. A tool row is one line: a long
 * URL or search query that wrapped would turn a scannable list into a wall,
 * so the row loses the tail rather than the shape.
 */
function truncateLine(text: string, columns: number): string {
  if (columns <= 0 || stringWidth(text) <= columns) return text;
  let out = "";
  for (const char of text) {
    if (stringWidth(out) + stringWidth(char) > columns - 1) break;
    out += char;
  }
  return `${out}…`;
}

/**
 * A shell command's `&&` chain, one segment per line with the connector
 * trailing each line but the last — legible whether the row is collapsed or
 * expanded, since the chain itself is never what the expand key hides.
 */
function shellChainSegments(command: string): readonly string[] {
  return command.includes(" && ") ? command.split(" && ") : [command];
}

/**
 * The always-visible head of a sentence-style tool row: mark (painted by
 * `toolPrefix`, not here) followed by verb + coloured subject, an optional
 * dim stat, and the expand arrow on its last physical line. A shell command's
 * `&&` chain spans several lines; every other tool call is one line.
 */
export function toolSentenceLines(row: StreamRow, columns?: number): StyledBodyLine[] {
  const fg = rowFg(row);
  const verb = row.verb ?? "";
  const subject = row.summary ?? row.text;
  // A verb that already names the whole call ("Linear: list issues") has no
  // subject to pair with, and a lone subject (a result sentence) has no verb.
  const head = verb.length === 0 ? "" : subject.length === 0 ? verb : `${verb} `;
  const stat = row.stat !== undefined && row.stat.length > 0 ? ` ${row.stat}` : "";
  const arrow = toolArrow(row);
  // Columns, not code units: the arrow is itself an ambiguous-width glyph and
  // this number is subtracted from the same budget `stringWidth(head)` is.
  const arrowWidth = stringWidth(arrow);
  const trailer = stringWidth(stat) + (arrowWidth > 0 ? arrowWidth + 1 : 0);
  const segments = shellChainSegments(
    columns === undefined || subject.includes(" && ")
      ? subject
      : truncateLine(subject, columns - stringWidth(head) - trailer),
  );
  const lines: StyledBodyLine[] = segments.map((segment, i) => {
    const lead: StyledBodyLine = i === 0 ? [{ text: head, fg }] : [{ text: CHAIN_INDENT, fg }];
    const isLast = i === segments.length - 1;
    const body: StyledBodyLine = [{ text: segment, fg: UI.inFlightBright }];
    const chain: StyledBodyLine = isLast ? [] : [{ text: " && \\", fg: UI.textDim }];
    return [...lead, ...body, ...chain];
  });
  const last = lines[lines.length - 1] ?? [];
  const statSegment = stat.length > 0 ? [{ text: stat, fg: UI.textDim }] : [];
  const arrowSegment = arrow.length > 0 ? [{ text: ` ${arrow}`, fg: UI.textDim }] : [];
  lines[lines.length - 1] = [...last, ...statSegment, ...arrowSegment];
  return lines;
}

/** A styled body line, indented by `columns` for a row's expanded detail. */
function indentStyledLine(line: StyledBodyLine, columns: number): StyledBodyLine {
  return [{ text: " ".repeat(columns), fg: UI.text }, ...line];
}

/**
 * Full painted body of a sentence-style tool row: the head, plus its diff or
 * structured detail indented beneath once expanded. Collapsing hides only
 * this tail — the head (and a shell chain's full structure) always shows.
 */
export function toolRowLines(row: StreamRow, columns?: number): StyledBodyLine[] {
  const head = toolSentenceLines(row, columns);
  if (row.expanded !== true) return head;
  const tail = row.diff !== undefined ? row.diff.lines : row.detail !== undefined ? row.detail : [];
  return [...head, ...tail.map((line) => indentStyledLine(line, TOOL_DETAIL_INDENT))];
}

/**
 * Format a stream row for the transcript. Content may span several lines: the
 * operator's bubble and a reasoning block are laid out here rather than left to
 * the renderer, which cannot right-align or inset a wrapped body.
 */
export function paintStreamRow(row: StreamRow, layout: RowLayout): PaintedStreamLine {
  const fg = rowFg(row);
  if (row.role === "user") {
    // A queued/steered/reinjected message looks identical to a plain sent
    // one otherwise — the operator needs to see, on the row itself, what
    // will happen to it, not just infer it from a badge count elsewhere.
    const prefix =
      row.cancelled === true
        ? "[cancelled] "
        : row.meta === "steer"
          ? "[will steer next] "
          : row.meta === "queue"
            ? "[will follow up] "
            : row.meta === "steering"
              ? "[steering] "
              : row.meta === "following-up"
                ? "[following up] "
                : row.meta === "reinject"
                  ? "[restarted here] "
                  : "";
    return { content: userBubbleLines(`${prefix}${row.text}`, layout.width).join("\n"), fg };
  }
  if (isThinkingRow(row)) {
    return {
      content: reasoningLines(row, layout).join("\n"),
      fg,
    };
  }
  const gutter = streamRowGutter(row, layout).content;
  return { content: `${gutter}${indentBody(rowBody(row, layout), gutter, layout)}`, fg };
}

/**
 * A body laid out under its own column: wrapped to the columns left beside the
 * prefix and indented onto them. Left to the renderer, a long line (raw tool
 * arguments, a wide result) wraps to column 0 — outside the shell's gutter and
 * outside the meta column — which breaks the one alignment the transcript has.
 */
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

/**
 * Vertical rhythm between transcript rows. A turn boundary (a different voice,
 * a different writer, or a different tool call) earns a blank row so the eye
 * can find it; a thinking row never does, so the coalesced line appearing or
 * disappearing above an answer cannot shift what is already on screen.
 */
export function rowGroupGap(previous: StreamRow | undefined, row: StreamRow): number {
  if (previous === undefined) return 0;
  // Thinking leads the answer it belongs to, so the turn's single gap is spent
  // below the reasoning line rather than above it: the settled phrase stays
  // glued to the turn that produced it and the answer gets its breathing room,
  // and the pair still costs exactly one gap either way.
  if (isThinkingRow(row)) return 0;
  if (isThinkingRow(previous)) return ROW_GROUP_GAP;
  if (previous.role !== row.role) return ROW_GROUP_GAP;
  // A block is a contiguous run from one writer; a change of writer is a
  // fresh block even when the role stays the same (one agent's tool call
  // followed by another agent's, say).
  if (gapWriter(previous) !== gapWriter(row)) return ROW_GROUP_GAP;
  // Same voice, different call: a result stays glued to the call it answers,
  // but the next call starts its own block.
  if (row.role === "tool" && (previous.meta ?? "") !== (row.meta ?? "")) {
    return ROW_GROUP_GAP;
  }
  return 0;
}

/** Whether this row's body should render as markdown rather than literal text. */
export function isMarkdownRow(row: StreamRow): boolean {
  if (row.structured !== undefined || row.diff !== undefined) return false;
  if (isDetailRow(row)) return false;
  // The operator's turn is a laid-out bubble, which a markdown body would
  // re-wrap and left-align out of the right gutter.
  if (row.role === "user") return false;
  return row.markdown ?? row.role === "assistant";
}

/** Whether this row paints a structured table body instead of its text. */
export function isStructuredRow(row: StreamRow): boolean {
  return row.structured !== undefined;
}

/**
 * Whether this row reads as a sentence — verb plus coloured subject, with an
 * arrow when there is something behind it. Calls earn it from their verb; a
 * result with no call to fold into earns it from the sentence its payload was
 * summarised into.
 */
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

/**
 * Whether the expand key has anything to do on this row. One idiom across the
 * product: a loaded skill, a summarised tool call and settled reasoning all
 * answer to the same key and say so on their collapsed line.
 */
export function isCollapsibleRow(row: StreamRow): boolean {
  if (row.skill !== undefined) return true;
  if (row.summary !== undefined && row.detail !== undefined) return true;
  if (row.summary !== undefined && row.structured !== undefined) return true;
  if (row.diff !== undefined) return true;
  return isThinkingRow(row) && row.thought !== undefined && row.streaming !== true;
}

/**
 * Prefix painted beside a body the renderer owns (markdown, table, diff).
 * Empty for a lone agent's own prose: with nothing to disambiguate, the answer
 * starts on the first column. Writer identity is a block-level header, not a
 * per-row prefix — see `blockLabel`.
 */
export function streamRowGutter(row: StreamRow, _layout: RowLayout): PaintedStreamLine {
  const fg = rowFg(row);
  if (row.role === "tool") return { content: toolPrefix(row), fg };
  const meta =
    row.meta !== undefined && row.meta.length > 0 && !isThinkingRow(row) ? fitMeta(row.meta) : "";
  return { content: meta, fg };
}

/**
 * Markdown styling for transcript bodies, mapped onto the role palette so
 * markdown rows read as the same product skin as plain rows.
 * Native scope names: `markup.*` for markdown, the rest for fenced-code
 * syntax highlighting.
 */
const MARKDOWN_STYLES = {
  default: { fg: UI.text },
  conceal: { fg: UI.textFaint, dim: true },
  // Tree-sitter markdown tags headings by level, and SyntaxStyle matches whole
  // scope names, so the unnumbered scope alone would never be hit.
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
  "markup.link": { fg: UI.inFlightBright, underline: true },
  "markup.link.label": { fg: UI.inFlightBright },
  "markup.link.url": { fg: UI.inFlightBright, underline: true },
  keyword: { fg: UI.inFlightBright },
  string: { fg: UI.done },
  number: { fg: UI.done },
  comment: { fg: UI.textFaint, italic: true },
  function: { fg: UI.inFlight },
  type: { fg: UI.inFlightBright },
  variable: { fg: UI.text },
  punctuation: { fg: UI.textDim },
} as const;

let cachedSyntaxStyle: SyntaxStyle | null = null;

/**
 * Shared transcript SyntaxStyle. Lazy because construction reaches into the
 * native render lib, which is unavailable until a renderer exists.
 */
export function transcriptSyntaxStyle(): SyntaxStyle {
  if (cachedSyntaxStyle === null) {
    cachedSyntaxStyle = SyntaxStyle.fromStyles({ ...MARKDOWN_STYLES });
  }
  return cachedSyntaxStyle;
}
