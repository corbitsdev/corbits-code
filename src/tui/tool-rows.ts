/**
 * One transcript row per tool use.
 *
 * A call and the answer it gets are one event, so they are one row: the call
 * paints while it is in flight, and its result resolves the same row in place —
 * marker, subject and expandable body — instead of appending a second, visually
 * orphaned line beneath it.
 *
 * A run of consecutive calls that paint the same sentence collapses onto one
 * row too. The row keeps saying what the call was rather than totalling the
 * answers: totals across separate calls (overlapping queries, partial failures)
 * are claims the payloads do not support, and a summary nobody can trust is
 * worse than a plainer one. The answers themselves sit behind the arrow.
 */

import { toolCallRow, type ToolCallRowInput } from "./diff.js";
import { resultBodyLines, toolResultRow, type ToolResultRowInput } from "./mcp-view.js";
import { extractMcpRecords } from "./mcp-result-format.js";
import type { StreamRow, StyledBodyLine } from "./stream.js";
import { UI } from "./theme.js";

/** Answers a coalesced run keeps behind its arrow before it stops collecting. */
const MAX_RUN_LINES = 30;

function runLine(text: string, fg: string = UI.text): StyledBodyLine {
  return [{ text, fg }];
}

function appendRunLine(lines: readonly StyledBodyLine[], text: string): readonly StyledBodyLine[] {
  if (lines.length > MAX_RUN_LINES) return lines;
  if (lines.length === MAX_RUN_LINES) {
    return [...lines, runLine("… more answers", UI.textDim)];
  }
  return [...lines, runLine(text)];
}

/** Longest an answer's own words may run before they belong behind the arrow. */
const MAX_ADDENDUM = 40;

/**
 * What an answer adds to the line its call already wrote: a count, a short
 * status — never prose, and never the payload itself. A fetched page, a file
 * body or a search dump says nothing on one line and would push the subject
 * (the URL, the path, the query) off the row, so anything unbounded is left
 * behind the expand key.
 */
export function resultAddendum(result: StreamRow): string | undefined {
  const payload = result.text.trim();
  if (payload.length === 0) return undefined;
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
 * Fold a tool result into the call row it answers.
 *
 * The row keeps saying what the call was — the URL fetched, the path read, the
 * query searched. That is the stable identifier, and it is the one thing the
 * payload can never be trusted to reproduce. The answer contributes the marker,
 * a short factual addendum where it has one, and the body behind the arrow.
 */
export function mergeToolRows(call: StreamRow, result: StreamRow): StreamRow {
  const failed = result.failed === true;
  const { pending: _pending, agentWorking: _agentWorking, stat: _stat, ...answered } = call;
  const addendum = failed ? undefined : resultAddendum(result);
  // A live sub-agent's elapsed-time trailer is scaffolding for the wait, not a
  // fact about the call the way a diff's own +/- count is — the answer's stat
  // must win over it rather than being shadowed by whatever it last read.
  const callStat = call.agentWorking !== undefined ? undefined : call.stat;
  const base: StreamRow = {
    ...answered,
    text: result.text,
    summary: call.summary ?? "",
    ...(failed || call.failed === true ? { failed: true } : {}),
    // A diff already states its own +/- counts; nothing the answer says beats it.
    ...(callStat === undefined && addendum !== undefined ? { stat: addendum } : {}),
    ...(callStat !== undefined ? { stat: callStat } : {}),
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
      ...(call.stat !== undefined ? { stat: call.stat } : {}),
      outstanding: remaining,
      ...(remaining > 0 ? { pending: true } : {}),
      detail: appendRunLine(call.detail ?? [], failed ? "call failed" : (addendum ?? "answered")),
    };
  }

  const payload = result.text.trim();
  const showsPayload = payload.length > 0 && payload !== base.stat;
  return {
    ...base,
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
    ...(showsPayload
      ? { detail: result.detail ?? resultBodyLines(result.text) }
      : call.detail !== undefined
        ? { detail: call.detail }
        : {}),
  };
}

/** Whether `next` is a repeat of the call the row before it already painted. */
export function canCoalesceCall(tail: StreamRow | undefined, next: StreamRow): boolean {
  if (tail === undefined || tail.role !== "tool" || next.role !== "tool") {
    return false;
  }
  return tail.callKey !== undefined && tail.callKey === next.callKey;
}

/**
 * Collapse a repeated call onto the row its predecessor already occupies. The
 * predecessor's own answer becomes the first line of the run's body, so nothing
 * it had said is lost to the collapse.
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
  const { detail: _detail, structured: _structured, diff: _diff, ...call } = next;
  const inFlight = tail.outstanding ?? (tail.pending === true ? 1 : 0);
  return {
    ...call,
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
export function pushToolResult(rows: StreamRow[], input: ToolResultRowInput): void {
  const result = toolResultRow(input);
  const index = pendingCallIndex(rows, input.name, input.callId);
  const call = index === -1 ? undefined : rows[index];
  if (call === undefined) {
    rows.push(result);
    return;
  }
  rows[index] = mergeToolRows(call, result);
}
