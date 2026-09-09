/**
 * Drive the parent back into a turn when the live fleet goes dry while
 * todo/doing tasks remain. Pure: the TUI subscriber decides when to call,
 * this module decides whether to drive and what to send.
 */

import { hasActiveTasks, type Task } from "../agent/tasks.js";
import { isLiveWaitStatus, type WaitJSONStatus } from "./lifecycle.js";

/** Enough of a lane report for a parent continuation; traces stay on disk. */
export const FLEET_DRY_REPORT_CHARS = 8_192;

export const FLEET_DRY_CONTINUATION_PREFIX = "The fleet has gone dry. Remaining open tasks:";

export interface FleetDryMailboxRecord {
  readonly status: WaitJSONStatus;
  readonly collected?: boolean;
  readonly report?: string;
  readonly error?: string;
  readonly description?: string;
  readonly hint?: string;
  readonly providerFailure?: true;
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
}

export function shouldDriveOpenTasks(input: {
  previousRunning: number;
  running: number;
  hasOpenTasks: boolean;
  parentProcessing: boolean;
}): boolean {
  const wentDry = input.running === 0 && input.previousRunning > 0;
  return wentDry && input.hasOpenTasks && !input.parentProcessing;
}

function clipField(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= FLEET_DRY_REPORT_CHARS) return text;
  return `${text.slice(0, FLEET_DRY_REPORT_CHARS - 1).trimEnd()}…`;
}

export function collectUncollectedTerminals(
  mailbox: FleetDryMailbox | undefined,
  lanes: readonly FleetDryLane[],
): CollectedWorkerReport[] {
  if (mailbox === undefined) return [];
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const reports: CollectedWorkerReport[] = [];
  for (const id of mailbox.ids()) {
    const peeked = mailbox.peek(id);
    if (peeked === undefined) continue;
    if (peeked.collected === true) continue;
    if (isLiveWaitStatus(peeked.status)) continue;
    const taken = mailbox.take(id) ?? peeked;
    const lane = byId.get(id);
    const report = clipField(taken.report ?? lane?.report);
    const error = clipField(taken.error ?? lane?.error);
    const description = taken.description ?? lane?.description;
    reports.push({
      agent_id: id,
      status: taken.status,
      ...(description !== undefined && description.length > 0 ? { description } : {}),
      ...(taken.status !== "failed" && report !== undefined ? { report } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(taken.hint !== undefined ? { hint: taken.hint } : {}),
      ...(taken.providerFailure === true ? { provider_failure: true } : {}),
    });
  }
  return reports;
}

export function buildFleetDryContinuationPrompt(
  tasks: readonly Task[],
  reports: readonly CollectedWorkerReport[],
): string {
  const open = tasks.filter((task) => task.status === "todo" || task.status === "doing");
  const taskLines = open.map((task) => `- ${task.id}: ${task.title} (${task.status})`).join("\n");
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
  previousRunning: number;
  running: number;
  openTasks: readonly Task[];
  parentProcessing: boolean;
  mailbox: FleetDryMailbox | undefined;
  lanes: readonly FleetDryLane[];
  beginSystemContinuation: (prompt: string) => void;
  send: (prompt: string) => void;
}): boolean {
  const tasks = [...args.openTasks];
  if (
    !shouldDriveOpenTasks({
      previousRunning: args.previousRunning,
      running: args.running,
      hasOpenTasks: hasActiveTasks(tasks),
      parentProcessing: args.parentProcessing,
    })
  ) {
    return false;
  }
  const reports = collectUncollectedTerminals(args.mailbox, args.lanes);
  const prompt = buildFleetDryContinuationPrompt(tasks, reports);
  args.beginSystemContinuation(prompt);
  args.send(prompt);
  return true;
}
