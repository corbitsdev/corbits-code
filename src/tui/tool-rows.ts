/**
 * One transcript row per tool use: a call and its answer resolve in place.
 * Repeats collapse onto the call's row; the row keeps saying what the call
 * was — totals across calls are claims the payloads cannot support.
 */

import { toolCallRow, type ToolCallRowInput } from "./diff.js";
import {
  resultBodyLines,
  toolResultRow,
  type ToolResultRowInput,
} from "./mcp-view.js";
import { extractMcpRecords } from "./mcp-result-format.js";
import { abbreviate } from "./tool-formatter.js";
import type { StreamRow, StyledBodyLine } from "./stream.js";
import { UI } from "./theme.js";

/** Answers a coalesced run keeps behind its arrow before it stops collecting. */
const MAX_RUN_LINES = 30;

function runLine(text: string, fg: string = UI.text): StyledBodyLine {
  return [{ text, fg }];
}

function appendRunLine(
  lines: readonly StyledBodyLine[],
  line: StyledBodyLine,
): readonly StyledBodyLine[] {
  if (lines.length > MAX_RUN_LINES) return lines;
  if (lines.length === MAX_RUN_LINES) {
    return [...lines, runLine("… more answers", UI.textDim)];
  }
  return [...lines, line];
}

/** One lane member line: which call, then what it got; the label is dim so
 * the outcome reads first. */
function memberRunLine(label: string, outcome: string): StyledBodyLine {
  if (label.length === 0) return runLine(outcome);
  return [
    { text: label, fg: UI.textDim },
    { text: ` — ${outcome}`, fg: UI.text },
  ];
}

/**
 * Argument keys naming what a call acted on, most-identifying first. Used
 * only when the painted summary is empty — an MCP call's verb is the whole
 * sentence, so its subject lives in the arguments.
 */
const LANE_MEMBER_KEYS = [
  "issueId",
  "issue",
  "commentId",
  "id",
  "key",
  "command",
  "query",
  "url",
  "pattern",
  "path",
  "file_path",
  "name",
  "description",
  "prompt",
] as const;

const LANE_MEMBER_SUBJECT_MAX = 48;

function memberArgs(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** Which object a lane member acted on, read off its painted summary or args. */
function laneMemberLabel(row: StreamRow): string {
  // Label recorded at merge time, while the args were still on the row;
  // re-deriving reads the answer payload.
  if (row.callId !== undefined) {
    const index = (row.memberIds ?? []).indexOf(row.callId);
    const recorded = index >= 0 ? (row.memberLabels?.[index] ?? "") : "";
    if (recorded.length > 0) return recorded;
  }
  const summary = row.summary?.trim() ?? "";
  if (summary.length > 0) return abbreviate(summary, LANE_MEMBER_SUBJECT_MAX);
  const args = memberArgs(row.text);
  if (args !== null) {
    for (const key of LANE_MEMBER_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return abbreviate(value, LANE_MEMBER_SUBJECT_MAX);
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
    const first = Object.values(args).find(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    if (typeof first === "string")
      return abbreviate(first, LANE_MEMBER_SUBJECT_MAX);
  }
  return row.verb ?? row.meta ?? row.toolName ?? "";
}

/** The label the result's call carried when the lane absorbed it, if known. */
function memberLabelFor(call: StreamRow, result: StreamRow): string {
  if (result.callId === undefined) return "";
  const index = (call.memberIds ?? []).indexOf(result.callId);
  return index >= 0 ? (call.memberLabels?.[index] ?? "") : "";
}

/** Longest an answer's own words may run before they belong behind the arrow. */
const MAX_ADDENDUM = 40;

/** Failed-result addendum: same budget as `mergedToolCollapsedPreview` errors. */
const MAX_ERROR_ADDENDUM = 72;

/** Flatten a failed payload like the collapsed preview: one abbreviated
 * line, so the operator can read why without expanding. */
function failedAddendum(payload: string): string | undefined {
  const oneLine = payload
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
  if (oneLine.length === 0) return undefined;
  return oneLine.length <= MAX_ERROR_ADDENDUM
    ? oneLine
    : `${oneLine.slice(0, MAX_ERROR_ADDENDUM - 1)}…`;
}

/**
 * What an answer adds to its call's line: a count or short status on
 * success, the abbreviated error on failure — never prose. Anything
 * unbounded stays behind the expand key.
 */
export function resultAddendum(result: StreamRow): string | undefined {
  const payload = result.text.trim();
  if (payload.length === 0) return undefined;
  if (result.failed === true) return failedAddendum(payload);
  const records = extractMcpRecords(payload);
  if (records !== null) return countNoun(records.items.length, "result");
  const lines = payload.split("\n");
  if (lines.length === 1) {
    return payload.length <= MAX_ADDENDUM ? payload : undefined;
  }
  return countNoun(lines.length, "line");
}

function countNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Collapsed shell preview: the last three output lines plus a dim elision
 * marker carrying the count. */
const SHELL_PREVIEW_LINES = 3;

export function shellPreviewLines(content: string): string[] | undefined {
  const lines = content.replace(/\n+$/, "").split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === ""))
    return undefined;
  if (lines.length <= SHELL_PREVIEW_LINES) return lines;
  return [
    ...lines.slice(-SHELL_PREVIEW_LINES),
    `⋯ +${lines.length - SHELL_PREVIEW_LINES} lines`,
  ];
}

const SHELL_EXIT_ENVELOPE = /^exit code (\d+)\n/;

/**
 * Fold a tool result into the call row it answers. The row keeps saying
 * what the call was — the payload cannot reproduce it; the answer adds the
 * marker, a short addendum, and the body behind the arrow.
 */
export function mergeToolRows(call: StreamRow, result: StreamRow): StreamRow {
  const failed = result.failed === true;
  const isShell = call.toolName === "run_shell";
  // Shell exits come wrapped in an envelope; the exit code is the row's
  // only stat — the preview marker already counts lines.
  const exitMatch = isShell ? SHELL_EXIT_ENVELOPE.exec(result.text) : null;
  const exitCode = exitMatch !== null ? Number(exitMatch[1]) : undefined;
  const shellStat =
    exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined;
  // The envelope line is already the stat; drop it from the preview source.
  const previewSource =
    shellStat !== undefined
      ? result.text.replace(/^exit code \d+\n/, "")
      : result.text;
  const {
    pending: _pending,
    agentWorking: _agentWorking,
    stat: _stat,
    previewLines: _previewLines,
    ...answered
  } = call;
  const addendum = resultAddendum(result);
  const effAddendum =
    isShell && (shellStat !== undefined || !failed) ? undefined : addendum;
  // The answer's stat beats a leftover one — elapsed-time trailers are
  // scaffolding, and an error beats an unlanded diff.
  const callStat =
    failed || call.agentWorking !== undefined ? undefined : call.stat;
  const settledStat = shellStat ?? callStat;
  const base: StreamRow = {
    ...answered,
    text: result.text,
    summary: call.summary ?? "",
    ...(failed || call.failed === true ? { failed: true } : {}),
    // A diff already states its own +/- counts.
    ...(settledStat === undefined && effAddendum !== undefined
      ? { stat: effAddendum }
      : {}),
    ...(settledStat !== undefined ? { stat: settledStat } : {}),
  };

  if (call.coalesced === true) {
    // One call's count on a run row would read as a total nothing can
    // substantiate.
    const { stat: _stat, ...run } = base;
    const remaining = Math.max(0, (call.outstanding ?? 1) - 1);
    return {
      ...run,
      // The run's subject stays the repeated call; keep its text, not this
      // answer's payload.
      text: call.text,
      // The newest answer is the lane's copy source (Alt+C) and the shell
      // settle preview's source.
      resultText: result.text,
      ...(isShell && shellStat !== undefined ? { stat: shellStat } : {}),
      ...(!isShell && call.stat !== undefined ? { stat: call.stat } : {}),
      ...(isShell
        ? { previewLines: shellPreviewLines(previewSource) ?? [] }
        : {}),
      outstanding: remaining,
      ...(remaining > 0 ? { pending: true } : {}),
      detail: appendRunLine(
        call.detail ?? [],
        memberRunLine(
          memberLabelFor(call, result),
          failed ? (addendum ?? "call failed") : (addendum ?? "answered"),
        ),
      ),
    };
  }

  const payload = result.text.trim();
  const showsPayload = payload.length > 0 && payload !== base.stat;
  return {
    ...base,
    // Last moment this call's args are on the row — record who it was so a
    // later repeat can name it.
    ...(call.callId !== undefined
      ? {
          memberIds: [call.callId],
          memberLabels: [laneMemberLabel(call)],
        }
      : {}),
    ...(result.structured !== undefined
      ? { structured: result.structured }
      : {}),
    ...(isShell
      ? { previewLines: shellPreviewLines(previewSource) ?? [] }
      : {}),
    ...(showsPayload
      ? { detail: result.detail ?? resultBodyLines(result.text) }
      : call.detail !== undefined
        ? { detail: call.detail }
        : {}),
  };
}

/**
 * Whether `next` folds onto the tail's lane. Lanes group by raw tool identity,
 * not painted sentence — two reads of different files are still two reads.
 * `spawn_agent` never merges: each dispatch keeps its own progress anchor.
 */
export function canCoalesceCall(
  tail: StreamRow | undefined,
  next: StreamRow,
): boolean {
  if (tail === undefined || tail.role !== "tool" || next.role !== "tool") {
    return false;
  }
  const toolName = tail.toolName;
  if (toolName === undefined || toolName !== next.toolName) return false;
  return toolName !== "spawn_agent";
}

function laneMembers(
  tail: StreamRow,
  next: StreamRow,
): { ids: string[]; labels: string[] } {
  const tailIds =
    tail.memberIds ?? (tail.callId !== undefined ? [tail.callId] : []);
  // Hydrated lanes carry memberIds without labels; backfill placeholders to
  // keep the arrays aligned — only the tail's label is recoverable.
  const tailLabels =
    tail.memberLabels ??
    tailIds.map((id) => (id === tail.callId ? laneMemberLabel(tail) : ""));
  const ids = [...tailIds, ...(next.callId !== undefined ? [next.callId] : [])];
  const labels = [
    ...tailLabels,
    ...(next.callId !== undefined ? [laneMemberLabel(next)] : []),
  ];
  // Bound the lane's memory with the detail cap, oldest-first, both arrays
  // sliced together.
  return {
    ids: ids.slice(0, MAX_RUN_LINES),
    labels: labels.slice(0, MAX_RUN_LINES),
  };
}

/** Fold a repeat onto its predecessor's lane: the lane narrates the newest
 * call; the predecessor's settled answer opens the body behind the arrow. */
export function coalesceCallRows(tail: StreamRow, next: StreamRow): StreamRow {
  const answered =
    tail.coalesced === true
      ? (tail.detail ?? [])
      : tail.pending === true
        ? []
        : appendRunLine(
            [],
            memberRunLine(
              laneMemberLabel(tail),
              tail.failed === true
                ? (tail.stat ?? "call failed")
                : (tail.stat ?? "answered"),
            ),
          );
  // A run's body is its collected answers; the view, table and diff belonged
  // to one call.
  const {
    detail: _detail,
    structured: _structured,
    diff: _diff,
    ...call
  } = next;
  const inFlight = tail.outstanding ?? (tail.pending === true ? 1 : 0);
  const members = laneMembers(tail, next);
  return {
    ...call,
    callCount: (tail.callCount ?? 1) + 1,
    ...(members.ids.length > 0 ? { memberIds: members.ids } : {}),
    ...(members.labels.length > 0 ? { memberLabels: members.labels } : {}),
    coalesced: true,
    outstanding: inFlight + 1,
    ...(tail.failed === true ? { failed: true } : {}),
    ...(answered.length > 0 ? { detail: answered } : {}),
  };
}

/**
 * Index of the call row a result belongs to. A carried id wins: parallel
 * dispatch fires several same-name calls, and only the id tells them apart.
 * A miss returns -1 — falling through to the newest same-name row would
 * misattribute the result.
 *
 * The name scan runs only when `callId` is missing — pre-id history from
 * `history-hydrate.ts` is the only caller that omits it.
 */
export function pendingCallIndex(
  rows: readonly StreamRow[],
  name: string,
  callId?: string,
): number {
  if (callId !== undefined) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.callId === callId) return i;
    }
    // The lane's callId moved to its newest member; this result's id may
    // name one the lane absorbed earlier.
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.memberIds?.includes(callId)) return i;
    }
    return -1;
  }
  let fallback = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row === undefined || row.pending !== true) continue;
    if (row.meta === name) return i;
    if (fallback === -1) fallback = i;
  }
  return fallback;
}

/** Append a tool call to a row list, collapsing it onto a repeat of itself. */
export function pushToolCall(rows: StreamRow[], input: ToolCallRowInput): void {
  const row = toolCallRow(input);
  const tail = rows[rows.length - 1];
  if (tail !== undefined && canCoalesceCall(tail, row)) {
    rows[rows.length - 1] = coalesceCallRows(tail, row);
    return;
  }
  rows.push(row);
}

/** Fold a tool result into its call row, or append it when it answers none. */
export function pushToolResult(
  rows: StreamRow[],
  input: ToolResultRowInput,
): void {
  const result = toolResultRow(input);
  const index = pendingCallIndex(rows, input.name, input.callId);
  const call = index === -1 ? undefined : rows[index];
  if (call === undefined) {
    rows.push(result);
    return;
  }
  rows[index] = mergeToolRows(call, result);
}
