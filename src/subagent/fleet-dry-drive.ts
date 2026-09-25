/**
 * Drive the parent back into a turn when the live fleet goes dry while
 * todo/doing tasks remain. Pure: occupancy (settleRunToIdle) decides when
 * to call; this module decides whether to drive and what to send.
 */

import { hasActiveTasks, type Task } from "../agent/tasks.js";
import {
  truncationNotice,
  truncateWithReservedNotice,
} from "../plugins/result-truncation-plugin.js";
import { isLiveWaitStatus, type WaitJSONStatus } from "./lifecycle.js";

/** Enough of a lane report for a parent continuation; traces stay on disk. */
export const FLEET_DRY_REPORT_CHARS = 8_192;

export const FLEET_DRY_CONTINUATION_PREFIX =
  "The fleet has gone dry. Remaining open tasks:";

/**
 * Whether inbound text is the fleet-dry open-task continuation. Same class
 * as mailbox mail: internal runtime→agent traffic whose report-JSON payload
 * is model-facing, so the transcript never paints it.
 */
export function isFleetDryContinuationText(text: string): boolean {
  return text.startsWith(FLEET_DRY_CONTINUATION_PREFIX);
}

export interface FleetDryMailboxRecord {
  readonly status: WaitJSONStatus;
  readonly collected?: boolean;
  readonly report?: string;
  readonly error?: string;
  readonly description?: string;
  readonly hint?: string;
  readonly providerFailure?: true;
  /** CL-8978: transient provider failure — the parent may spawn one successor. */
  readonly recoverableFailure?: true;
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
  /**
   * CL-8978: failed entries from a transient provider failure carry this
   * marker plus single-successor guidance in continue_with. Capped affordance:
   * at most one respawn with the same brief, never a retry loop.
   */
  continuable?: true;
  continue_with?: string;
  stop_reason?: string;
}

/**
 * Single-successor guidance for a failed+continuable entry. The marker is
 * advisory only — no runtime auto-retry backs it.
 */
export const RECOVERABLE_FAILURE_CONTINUE_GUIDANCE =
  "This worker failed with a transient provider error (retryable/timeout/overload) " +
  "and is terminal — do not re-wait it. You may spawn at most one successor with " +
  "the same brief; do not retry in a loop.";

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

export function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

/** TUI send returns a delivery-result object. Only `accepted` consumes a wake. */
function occupancySendSucceeded(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "accepted"
  );
}

export async function settleOccupancySend(args: {
  send: () => unknown;
  onSuccess: () => void;
  onFailure: () => boolean;
}): Promise<boolean> {
  try {
    const sent = args.send();
    const result = isPromiseLike(sent) ? await sent : sent;
    if (!occupancySendSucceeded(result)) return args.onFailure();
    args.onSuccess();
    return true;
  } catch {
    return args.onFailure();
  }
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

async function clipField(
  text: string | undefined,
  agentId: string,
  field: "report" | "error",
  writeBlob?: FleetDryBlobWriter,
): Promise<string | undefined> {
  if (text === undefined) return undefined;
  if (text.length <= FLEET_DRY_REPORT_CHARS) return text;
  let uri: string | undefined;
  if (writeBlob !== undefined) {
    const key = fleetDrySpillKey(agentId, field);
    try {
      await writeBlob(key, new TextEncoder().encode(text), "text/plain");
      uri = `tool-output:///${key}`;
    } catch {
      // Rejected write: same honest cut as a missing writer — no URI.
    }
  }
  return truncateWithReservedNotice(text, FLEET_DRY_REPORT_CHARS, (keptLen) =>
    truncationNotice({
      maxChars: FLEET_DRY_REPORT_CHARS,
      remaining: text.length - keptLen,
      fullLength: text.length,
      contentType: "text/plain",
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
    ...(taken.status === "failed" && taken.recoverableFailure === true
      ? {
          continuable: true as const,
          continue_with: RECOVERABLE_FAILURE_CONTINUE_GUIDANCE,
        }
      : {}),
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

async function clipCollectedReport(
  report: CollectedWorkerReport,
  writeBlob?: FleetDryBlobWriter,
): Promise<CollectedWorkerReport> {
  const clippedReport = await clipField(
    report.report,
    report.agent_id,
    "report",
    writeBlob,
  );
  const clippedError = await clipField(
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

export async function collectUncollectedTerminals(
  mailbox: FleetDryMailbox | undefined,
  lanes: readonly FleetDryLane[],
  consume: boolean,
  writeBlob?: FleetDryBlobWriter,
): Promise<CollectedWorkerReport[]> {
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
    reports.push(await clipCollectedReport(projected, writeBlob));
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
}): boolean | Promise<boolean> {
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
  return driveOpenTasksAfterFleetDrySpill(args, tasks);
}

async function driveOpenTasksAfterFleetDrySpill(
  args: Parameters<typeof driveOpenTasksAfterFleetDry>[0],
  tasks: Task[],
): Promise<boolean> {
  const reports = await collectUncollectedTerminals(
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
  } catch {
    return fail();
  }
  return settleOccupancySend({
    send: () => args.send(prompt),
    onSuccess: takeReports,
    onFailure: fail,
  });
}
