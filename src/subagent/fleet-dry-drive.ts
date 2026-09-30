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
import { parseSubAgentReport } from "./report.js";

/** Enough of a lane report for a parent continuation; traces stay on disk. */
export const FLEET_DRY_REPORT_CHARS = 8_192;

/** Summary/Blockers inline in mailbox digest; the blob holds the rest. */
export const MAILBOX_DIGEST_SECTION_CHARS = 2_048;

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

/**
 * Ids occupancy has snapshotted and handed to send, but not yet taken.
 * Shared by mailbox mail and fleet-dry so one parent window cannot paste the
 * same agent twice. Failed send clears the set so a later flush can retry.
 * Weak-keyed so a mailbox object can go away without a leak.
 */
const occupancyDeliveringByMailbox = new WeakMap<
  FleetDryMailbox,
  Set<string>
>();

export function occupancyDeliveringSet(mailbox: FleetDryMailbox): Set<string> {
  let ids = occupancyDeliveringByMailbox.get(mailbox);
  if (ids === undefined) {
    ids = new Set();
    occupancyDeliveringByMailbox.set(mailbox, ids);
  }
  return ids;
}

export function releaseOccupancyDelivering(
  mailbox: FleetDryMailbox | undefined,
  ids: readonly string[],
): void {
  if (mailbox === undefined) return;
  const delivering = occupancyDeliveringByMailbox.get(mailbox);
  if (delivering === undefined) return;
  for (const id of ids) delivering.delete(id);
}

export function dedupeByAgentId<T extends { agent_id: string }>(
  reports: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const report of reports) {
    if (seen.has(report.agent_id)) continue;
    seen.add(report.agent_id);
    out.push(report);
  }
  return out;
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

/** Mailbox parent payload: envelope digest plus a blob pointer, not the full report. */
export interface MailboxWorkerDigest {
  agent_id: string;
  status: string;
  description?: string;
  summary?: string;
  findings?: string;
  blockers?: string;
  report?: string;
  report_uri?: string;
  error?: string;
  error_uri?: string;
  hint?: string;
  provider_failure?: true;
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

function clipDigestSection(text: string): string {
  if (text.length <= MAILBOX_DIGEST_SECTION_CHARS) return text;
  return `${text.slice(0, MAILBOX_DIGEST_SECTION_CHARS - 1).trimEnd()}…`;
}

function mailboxSpillNotice(text: string, uri: string): string {
  // Digest inlines the notice only, so remaining is the omitted body — not
  // length minus a 2048-char prefix that was never kept. A short spill that
  // claimed "0 more chars omitted" looks complete and the parent skips read_file.
  return truncationNotice({
    maxChars: MAILBOX_DIGEST_SECTION_CHARS,
    remaining: text.length,
    fullLength: text.length,
    contentType: "text/plain",
    uri,
  }).trim();
}

export async function spillWorkerField(
  text: string | undefined,
  agentId: string,
  field: "report" | "error",
  writeBlob?: FleetDryBlobWriter,
): Promise<string | undefined> {
  if (text === undefined || writeBlob === undefined) return undefined;
  const key = fleetDrySpillKey(agentId, field);
  try {
    await writeBlob(key, new TextEncoder().encode(text), "text/plain");
    return `tool-output:///${key}`;
  } catch {
    return undefined;
  }
}

export function slimCollectedReport(
  report: CollectedWorkerReport,
): Pick<CollectedWorkerReport, "agent_id" | "status" | "description"> {
  return {
    agent_id: report.agent_id,
    status: report.status,
    ...(report.description !== undefined && report.description.length > 0
      ? { description: report.description }
      : {}),
  };
}

export async function digestCollectedReport(
  report: CollectedWorkerReport,
  writeBlob?: FleetDryBlobWriter,
): Promise<MailboxWorkerDigest> {
  const parsed =
    report.report !== undefined
      ? parseSubAgentReport(report.report)
      : undefined;
  const reportUri = await spillWorkerField(
    report.report,
    report.agent_id,
    "report",
    writeBlob,
  );
  const errorUri = await spillWorkerField(
    report.error,
    report.agent_id,
    "error",
    writeBlob,
  );
  const summary =
    parsed !== undefined && parsed.summary.length > 0
      ? clipDigestSection(parsed.summary)
      : undefined;
  const findings =
    parsed !== undefined && summary === undefined && parsed.findings.length > 0
      ? clipDigestSection(parsed.findings)
      : undefined;
  const blockers =
    parsed !== undefined
      ? clipDigestSection(
          parsed.blockers.length > 0 ? parsed.blockers : "None.",
        )
      : undefined;
  const reportInline =
    report.report === undefined
      ? undefined
      : reportUri !== undefined
        ? mailboxSpillNotice(report.report, reportUri)
        : await clipField(report.report, report.agent_id, "report");
  const errorInline =
    report.error === undefined
      ? undefined
      : errorUri !== undefined
        ? mailboxSpillNotice(report.error, errorUri)
        : clipDigestSection(report.error);
  return {
    agent_id: report.agent_id,
    status: report.status,
    ...(report.description !== undefined && report.description.length > 0
      ? { description: report.description }
      : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(findings !== undefined ? { findings } : {}),
    ...(blockers !== undefined ? { blockers } : {}),
    ...(reportInline !== undefined ? { report: reportInline } : {}),
    ...(reportUri !== undefined ? { report_uri: reportUri } : {}),
    ...(errorInline !== undefined ? { error: errorInline } : {}),
    ...(errorUri !== undefined ? { error_uri: errorUri } : {}),
    ...(report.hint !== undefined ? { hint: report.hint } : {}),
    ...(report.provider_failure === true ? { provider_failure: true } : {}),
    ...(report.continuable === true
      ? {
          continuable: true as const,
          ...(report.continue_with !== undefined
            ? { continue_with: report.continue_with }
            : {}),
        }
      : {}),
    ...(report.stop_reason !== undefined
      ? { stop_reason: report.stop_reason }
      : {}),
  };
}

export async function digestCollectedReports(
  reports: readonly CollectedWorkerReport[],
  writeBlob?: FleetDryBlobWriter,
): Promise<MailboxWorkerDigest[]> {
  const out: MailboxWorkerDigest[] = [];
  for (const report of dedupeByAgentId(reports)) {
    out.push(await digestCollectedReport(report, writeBlob));
  }
  return out;
}

export function collectAlreadyCollectedStubs(
  mailbox: FleetDryMailbox | undefined,
  lanes: readonly FleetDryLane[],
): CollectedWorkerReport[] {
  if (mailbox === undefined) return [];
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const stubs: CollectedWorkerReport[] = [];
  const seen = new Set<string>();
  for (const id of mailbox.ids()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const peeked = mailbox.peek(id);
    if (peeked === undefined || peeked.collected !== true) continue;
    if (isLiveWaitStatus(peeked.status)) continue;
    const description = peeked.description ?? byId.get(id)?.description;
    stubs.push(
      slimCollectedReport({
        agent_id: id,
        status: peeked.status,
        ...(description !== undefined && description.length > 0
          ? { description }
          : {}),
      }),
    );
  }
  return stubs;
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
  clip = true,
): Promise<CollectedWorkerReport[]> {
  if (mailbox === undefined) return [];
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const reports: CollectedWorkerReport[] = [];
  const seen = new Set<string>();
  for (const id of mailbox.ids()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const peeked = mailbox.peek(id);
    if (peeked === undefined) continue;
    if (peeked.collected === true) continue;
    if (isLiveWaitStatus(peeked.status)) continue;
    const projected = consume
      ? takeAndProjectMailboxRecord(mailbox, id, byId.get(id))
      : projectMailboxRecord(id, peeked, byId.get(id));
    if (projected === undefined) continue;
    reports.push(
      clip ? await clipCollectedReport(projected, writeBlob) : projected,
    );
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
    JSON.stringify(dedupeByAgentId(reports)),
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
  const delivering =
    args.mailbox !== undefined
      ? occupancyDeliveringSet(args.mailbox)
      : new Set<string>();
  const uncollected = (
    await collectUncollectedTerminals(
      args.mailbox,
      args.lanes,
      false,
      args.writeBlob,
    )
  ).filter((report) => !delivering.has(report.agent_id));
  const uncollectedIds = new Set(uncollected.map((report) => report.agent_id));
  const stubs = collectAlreadyCollectedStubs(args.mailbox, args.lanes).filter(
    (stub) =>
      !uncollectedIds.has(stub.agent_id) && !delivering.has(stub.agent_id),
  );
  const reports = dedupeByAgentId([...uncollected, ...stubs]);
  const takeIds = uncollected.map((report) => report.agent_id);
  for (const id of takeIds) delivering.add(id);
  const prompt = buildFleetDryContinuationPrompt(tasks, reports);
  const takeReports = (): void => {
    for (const id of takeIds) {
      args.mailbox?.take(id);
    }
    releaseOccupancyDelivering(args.mailbox, takeIds);
  };
  const fail = (): boolean => {
    releaseOccupancyDelivering(args.mailbox, takeIds);
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
