/**
 * Drive the parent back into a turn when the live fleet goes dry while
 * todo/doing tasks remain. Pure: occupancy (settleRunToIdle) decides when
 * to call; this module decides whether to drive and what to send.
 */

import { hasActiveTasks, type Task } from "../agent/tasks.js";
import { isLiveWaitStatus, type WaitJSONStatus } from "./lifecycle.js";

/** Enough of a lane report for a parent continuation; traces stay on disk. */
export const FLEET_DRY_REPORT_CHARS = 8_192;

export const FLEET_DRY_CONTINUATION_PREFIX =
  "The fleet has gone dry. Remaining open tasks:";

export interface FleetDryMailboxRecord {
  readonly status: WaitJSONStatus;
  readonly collected?: boolean;
  readonly report?: string;
  readonly error?: string;
  readonly description?: string;
  readonly hint?: string;
  readonly providerFailure?: true;
  readonly stopReason?: string;
}

export interface FleetDryMailbox {
  ids(): readonly string[];
  peek(id: string): FleetDryMailboxRecord | undefined;
  take(id: string): FleetDryMailboxRecord | undefined;
}

export interface FleetDryLane {
  readonly id: string;
  readonly description?: string;
  readonly report?: string;
  readonly error?: string;
}

export interface CollectedWorkerReport {
  agent_id: string;
  status: string;
  description?: string;
  report?: string;
  error?: string;
  hint?: string;
  provider_failure?: true;
  stop_reason?: string;
}

export function shouldDriveOpenTasks(input: {
  previousRunning?: number | undefined;
  running?: number | undefined;
  hasOpenTasks: boolean;
  parentProcessing: boolean;
  deferredDryEdge?: boolean;
}): boolean {
  const running = input.running ?? 0;
  const previousRunning = input.previousRunning ?? 0;
  const wentDry = running === 0 && previousRunning > 0;
  const dryEdge = wentDry || input.deferredDryEdge === true;
  return (
    dryEdge && running === 0 && input.hasOpenTasks && !input.parentProcessing
  );
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

/** Session blob-store write; same shape as ContextStore.writeBlob. */
export type FleetDryBlobWriter = (
  key: string,
  bytes: Uint8Array,
  contentType: string,
) => void | Promise<void>;

/** Distinct from leisure `{callId}:full` so a reactor size-cap cannot clobber this spill. */
export function fleetDrySpillKey(
  agentId: string,
  field: "report" | "error",
): string {
  return `fleet-dry:${agentId}:${field}`;
}

function truncationNotice(args: {
  maxChars: number;
  remaining: number;
  fullLength: number;
  uri?: string;
}): string {
  const { maxChars, remaining, fullLength, uri } = args;
  if (uri === undefined) {
    return (
      `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
      `${remaining.toLocaleString()} chars discarded, NOT retrievable ` +
      `(no blob store is configured; re-running gives the same cut). ` +
      `Use offset/limit or a narrower query.]`
    );
  }
  return (
    `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
    `${remaining.toLocaleString()} more chars omitted here. The full result ` +
    `(${fullLength.toLocaleString()} chars, text/plain) is saved at ${uri}` +
    ` — use read_file with that URI (offset/limit supported) to see the rest.]`
  );
}

function truncateWithReservedNotice(
  text: string,
  maxChars: number,
  buildNotice: (keptLen: number) => string,
): string {
  let keptLen = maxChars;
  for (let i = 0; i < 8; i++) {
    const notice = buildNotice(keptLen);
    const total = keptLen + notice.length;
    if (total <= maxChars) return text.slice(0, keptLen) + notice;
    keptLen -= total - maxChars;
    if (keptLen < 0) keptLen = 0;
  }
  const notice = buildNotice(keptLen);
  return (text.slice(0, keptLen) + notice).slice(0, maxChars);
}

function clipField(
  text: string | undefined,
  agentId: string,
  field: "report" | "error",
  writeBlob?: FleetDryBlobWriter,
): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= FLEET_DRY_REPORT_CHARS) return text;
  let uri: string | undefined;
  if (writeBlob !== undefined) {
    const key = fleetDrySpillKey(agentId, field);
    uri = `tool-output:///${key}`;
    void writeBlob(key, new TextEncoder().encode(text), "text/plain");
  }
  return truncateWithReservedNotice(text, FLEET_DRY_REPORT_CHARS, (keptLen) =>
    truncationNotice({
      maxChars: FLEET_DRY_REPORT_CHARS,
      remaining: text.length - keptLen,
      fullLength: text.length,
      ...(uri !== undefined ? { uri } : {}),
    }),
  );
}

export function projectMailboxRecord(
  id: string,
  taken: FleetDryMailboxRecord,
  lane?: FleetDryLane,
): CollectedWorkerReport {
  const report = taken.report ?? lane?.report;
  const error = taken.error ?? lane?.error;
  const description = taken.description ?? lane?.description;
  return {
    agent_id: id,
    status: taken.status,
    ...(description !== undefined && description.length > 0
      ? { description }
      : {}),
    ...(taken.status !== "failed" && report !== undefined ? { report } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(taken.hint !== undefined ? { hint: taken.hint } : {}),
    ...(taken.providerFailure === true ? { provider_failure: true } : {}),
    ...(taken.stopReason !== undefined
      ? { stop_reason: taken.stopReason }
      : {}),
  };
}

/**
 * Mailbox take plus the wait_agents/fleet-dry projection. Live statuses are
 * not collected. Callers that need question fields (wait_agents) spread them
 * from the pre-take peek.
 */
export function takeAndProjectMailboxRecord(
  mailbox: FleetDryMailbox,
  id: string,
  lane?: FleetDryLane,
): CollectedWorkerReport | undefined {
  const peeked = mailbox.peek(id);
  if (peeked === undefined) return undefined;
  if (isLiveWaitStatus(peeked.status)) return undefined;
  const taken = mailbox.take(id) ?? peeked;
  return projectMailboxRecord(id, taken, lane);
}

function clipCollectedReport(
  report: CollectedWorkerReport,
  writeBlob?: FleetDryBlobWriter,
): CollectedWorkerReport {
  const clippedReport = clipField(
    report.report,
    report.agent_id,
    "report",
    writeBlob,
  );
  const clippedError = clipField(
    report.error,
    report.agent_id,
    "error",
    writeBlob,
  );
  return {
    ...report,
    ...(clippedReport !== undefined ? { report: clippedReport } : {}),
    ...(clippedError !== undefined ? { error: clippedError } : {}),
  };
}

export function collectUncollectedTerminals(
  mailbox: FleetDryMailbox | undefined,
  lanes: readonly FleetDryLane[],
  consume: boolean,
  writeBlob?: FleetDryBlobWriter,
): CollectedWorkerReport[] {
  if (mailbox === undefined) return [];
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const reports: CollectedWorkerReport[] = [];
  for (const id of mailbox.ids()) {
    const peeked = mailbox.peek(id);
    if (peeked === undefined) continue;
    if (peeked.collected === true) continue;
    if (isLiveWaitStatus(peeked.status)) continue;
    const projected = consume
      ? takeAndProjectMailboxRecord(mailbox, id, byId.get(id))
      : projectMailboxRecord(id, peeked, byId.get(id));
    if (projected === undefined) continue;
    reports.push(clipCollectedReport(projected, writeBlob));
  }
  return reports;
}

export function buildFleetDryContinuationPrompt(
  tasks: readonly Task[],
  reports: readonly CollectedWorkerReport[],
): string {
  const open = tasks.filter(
    (task) => task.status === "todo" || task.status === "doing",
  );
  const taskLines = open
    .map((task) => `- ${task.id}: ${task.title} (${task.status})`)
    .join("\n");
  return [
    FLEET_DRY_CONTINUATION_PREFIX,
    taskLines,
    "",
    "Collected worker reports (already collected — do not call wait_agents for these agent_ids):",
    JSON.stringify(reports),
    "",
    "Continue the remaining work. Mark each task done or cancelled with manage_tasks",
    "when finished, or spawn_agent the next specialist. Do not end this turn while",
    "tasks are still todo/doing unless you dispatch live workers.",
  ].join("\n");
}

export function driveOpenTasksAfterFleetDry(args: {
  previousRunning?: number | undefined;
  running?: number | undefined;
  openTasks: readonly Task[];
  parentProcessing: boolean;
  deferredDryEdge?: boolean;
  mailbox: FleetDryMailbox | undefined;
  lanes: readonly FleetDryLane[];
  writeBlob?: FleetDryBlobWriter;
  beginSystemContinuation: (prompt: string) => void;
  send: (prompt: string) => unknown;
  onSendFailure?: () => void;
}): boolean {
  const tasks = [...args.openTasks];
  if (
    !shouldDriveOpenTasks({
      previousRunning: args.previousRunning,
      running: args.running,
      hasOpenTasks: hasActiveTasks(tasks),
      parentProcessing: args.parentProcessing,
      ...(args.deferredDryEdge === true ? { deferredDryEdge: true } : {}),
    })
  ) {
    return false;
  }
  const reports = collectUncollectedTerminals(
    args.mailbox,
    args.lanes,
    false,
    args.writeBlob,
  );
  const prompt = buildFleetDryContinuationPrompt(tasks, reports);
  const takeReports = (): void => {
    for (const report of reports) {
      args.mailbox?.take(report.agent_id);
    }
  };
  const fail = (): boolean => {
    args.onSendFailure?.();
    return false;
  };
  try {
    args.beginSystemContinuation(prompt);
    const sent = args.send(prompt);
    if (isPromiseLike(sent)) {
      void sent.then(
        (result) => {
          if (result !== false) takeReports();
          else args.onSendFailure?.();
        },
        () => {
          args.onSendFailure?.();
        },
      );
      return true;
    }
    if (sent === false) return fail();
    takeReports();
  } catch {
    return fail();
  }
  return true;
}
