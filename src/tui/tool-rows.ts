/**
 * One transcript row per tool use.
 *
 * A call and the answer it gets are one event, so they are one row: the call
 * paints while it is in flight, and its result resolves the same row in place —
 * marker, subject and expandable body — instead of appending a second, visually
 * orphaned line beneath it.
 *
 * A run of consecutive calls to the same raw tool collapses onto one row
 * too. The row keeps saying what the call was rather than totalling the
 * answers: totals across separate calls (overlapping queries, partial failures)
 * are claims the payloads do not support, and a summary nobody can trust is
 * worse than a plainer one. The answers themselves sit behind the arrow.
 */

import { toolCallRow, type ToolCallRowInput } from "./diff.js";
import {
  resultBodyLines,
  toolResultRow,
  type ToolResultRowInput,
} from "./mcp-view.js";
import { extractMcpRecords } from "./mcp-result-format.js";
import type { StreamRow, StyledBodyLine } from "./stream.js";
import { UI } from "./theme.js";

/** Answers a coalesced run keeps behind its arrow before it stops collecting. */
const MAX_RUN_LINES = 30;

function runLine(text: string, fg: string = UI.text): StyledBodyLine {
  return [{ text, fg }];
}

function appendRunLine(
  lines: readonly StyledBodyLine[],
  text: string,
): readonly StyledBodyLine[] {
  if (lines.length > MAX_RUN_LINES) return lines;
  if (lines.length === MAX_RUN_LINES) {
    return [...lines, runLine("… more answers", UI.textDim)];
  }
  return [...lines, runLine(text)];
}

/** Longest an answer's own words may run before they belong behind the arrow. */
const MAX_ADDENDUM = 40;

/** Failed-result addendum: same budget as `mergedToolCollapsedPreview` errors. */
const MAX_ERROR_ADDENDUM = 72;

/**
 * Flatten a failed payload the way the collapsed log preview does: one line,
 * abbreviated, so the operator can read why without expanding.
 */
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
 * What an answer adds to the line its call already wrote. A success contributes
 * a count or a short status — never prose, and never the payload itself. A
 * failure contributes the error, abbreviated, because that is the one thing
 * the operator must be able to read without pressing expand. A fetched page, a
 * file body or a search dump says nothing on one line and would push the
 * subject (the URL, the path, the query) off the row, so anything unbounded
 * is left behind the expand key.
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

/**
 * Collapsed shell preview painted between the head and the expand hint: the
 * output's last three lines plus a dim elision marker that carries the count.
 * The full output stays behind the arrow.
 */
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
 * Fold a tool result into the lane/call row it answers.
 *
 * The row keeps saying what the call was — the URL fetched, the path read, the
 * query searched. That is the stable identifier, and it is the one thing the
 * payload can never be trusted to reproduce. The answer contributes the marker,
 * a short factual addendum where it has one (the error, when it failed), and
 * the body behind the arrow.
 */
export function mergeToolRows(call: StreamRow, result: StreamRow): StreamRow {
  const failed = result.failed === true;
  const isShell = call.toolName === "run_shell";
  // A shell answer carries its exit in the content envelope the guard wraps
  // non-zero exits in. The envelope's code becomes the row's only stat —
  // today's "N lines" stat is dropped for shell rows because the preview's
  // elision marker already carries the count.
  const exitMatch = isShell ? SHELL_EXIT_ENVELOPE.exec(result.text) : null;
  const exitCode = exitMatch !== null ? Number(exitMatch[1]) : undefined;
  const shellStat =
    exitCode !== undefined && exitCode !== 0 ? `exit ${exitCode}` : undefined;
  // The exit envelope line is already the row's stat; do not repeat it in the
  // collapsed preview.
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
  // A live sub-agent's elapsed-time trailer is scaffolding for the wait, not a
  // fact about the call the way a diff's own +/- count is — the answer's stat
  // must win over it rather than being shadowed by whatever it last read.
  // A failure's error likewise beats a leftover +/- count: the operator needs
  // the reason, not a diff that did not land.
  const callStat =
    failed || call.agentWorking !== undefined ? undefined : call.stat;
  const settledStat = shellStat ?? callStat;
  const base: StreamRow = {
    ...answered,
    text: result.text,
    summary: call.summary ?? "",
    ...(failed || call.failed === true ? { failed: true } : {}),
    // A diff already states its own +/- counts; nothing the answer says beats it.
    ...(settledStat === undefined && effAddendum !== undefined
      ? { stat: effAddendum }
      : {}),
    ...(settledStat !== undefined ? { stat: settledStat } : {}),
  };

  if (call.coalesced === true) {
    // One call's count on a row standing for eight of them would read as a
    // total across the run, which nothing here can substantiate.
    const { stat: _stat, ...run } = base;
    const remaining = Math.max(0, (call.outstanding ?? 1) - 1);
    return {
      ...run,
      // The run's subject stays the call it repeats, so the row keeps the
      // call's own text rather than taking on this one answer's payload.
      text: call.text,
      // The most recent answer is the lane's copy source (Alt+C) and, for a
      // shell lane, the settle preview's source.
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
        failed ? "call failed" : (addendum ?? "answered"),
      ),
    };
  }

  const payload = result.text.trim();
  const showsPayload = payload.length > 0 && payload !== base.stat;
  return {
    ...base,
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

/** Whether `next` folds onto the lane the tail row already represents.
 *
 * The lane groups by raw tool identity, not by the sentence a call paints:
 * two reads of different files are still two reads, and a lane of them is
 * easier to read than a stack of near-identical rows. `spawn_agent` is
 * excluded — each dispatch is its own live progress anchor for its whole
 * lifetime, so it must never merge.
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

/** Calls a lane remembers so a later result can still find this row. */

function laneMembers(tail: StreamRow, next: StreamRow): string[] | undefined {
  const members = [
    ...(tail.memberIds ?? (tail.callId !== undefined ? [tail.callId] : [])),
    ...(next.callId !== undefined ? [next.callId] : []),
  ];
  return members.length > 0 ? members : undefined;
}

/**
 * Fold a repeated call onto the lane its predecessor already occupies. The
 * lane narrates the newest call; the predecessor's own answer (when the lane
 * had already settled) becomes the first line of the body it keeps behind
 * the arrow.
 */
export function coalesceCallRows(tail: StreamRow, next: StreamRow): StreamRow {
  const answered =
    tail.coalesced === true
      ? (tail.detail ?? [])
      : tail.pending === true
        ? []
        : appendRunLine([], tail.stat ?? "answered");
  // A run's body is the answers it collected; the argument view, table and diff
  // belong to a single call, which this row no longer stands alone for.
  const {
    detail: _detail,
    structured: _structured,
    diff: _diff,
    ...call
  } = next;
  const inFlight = tail.outstanding ?? (tail.pending === true ? 1 : 0);
  const memberIds = laneMembers(tail, next);
  return {
    ...call,
    callCount: (tail.callCount ?? 1) + 1,
    ...(memberIds !== undefined ? { memberIds } : {}),
    coalesced: true,
    outstanding: inFlight + 1,
    ...(tail.failed === true ? { failed: true } : {}),
    ...(answered.length > 0 ? { detail: answered } : {}),
  };
}

/**
 * Index of the call row a result belongs to.
 *
 * A carried call id is exact and wins outright — it is the only thing that
 * tells two in-flight calls to the same tool apart, which parallel sub-agent
 * dispatch produces on every turn that fires more than one `spawn_agent` call
 * (three dispatches all show `meta === "spawn_agent"`; name alone cannot tell them apart).
 * An id that matches nothing on the log still returns -1 rather than falling
 * through to the name scan below: every current caller (the live bridge's own
 * call map, `SubAgentTranscriptEntry`, `BridgeInboundEvent`) always carries an
 * id, so a miss here is a real mismatch, not a legacy record, and papering
 * over it with the newest same-name row is the exact misattribution this
 * function exists to prevent.
 *
 * The name scan only runs when `callId` is `undefined` — saved history from
 * before ids were threaded through `HistoryBlock` (`history-hydrate.ts`) is
 * the one caller that still omits it.
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
    // A lane's own callId has already moved to its newest member, so the id
    // this result carries may be one the lane absorbed earlier.
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
