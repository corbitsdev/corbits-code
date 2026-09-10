/**
 * Drive the parent back into a turn when uncollected mailbox terminals exist
 * while Skywalker is idle. Pure: occupancy decides when to call; this module
 * decides whether to drive and what to send. Sibling of fleet-dry-drive —
 * per-item, not last-lane + open-tasks.
 */

import { isLiveWaitStatus } from "./lifecycle.js";
import {
  collectUncollectedTerminals,
  type CollectedWorkerReport,
  type FleetDryLane,
  type FleetDryMailbox,
} from "./fleet-dry-drive.js";

export const MAILBOX_MAIL_WAKE_PREFIX = "mailbox mail";

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

export function occupancyShouldYieldWait(
  mailbox: FleetDryMailbox | undefined,
): boolean {
  if (mailbox === undefined) return false;
  for (const id of mailbox.ids()) {
    const record = mailbox.peek(id);
    if (record === undefined) continue;
    if (record.status === "awaiting_director") return true;
    if (record.collected === true) continue;
    if (!isLiveWaitStatus(record.status)) return true;
  }
  return false;
}

export function buildMailboxMailPrompt(
  reports: readonly CollectedWorkerReport[],
): string {
  return [
    `${MAILBOX_MAIL_WAKE_PREFIX} — worker reports (already collected — do not call wait_agents for these agent_ids):`,
    JSON.stringify(reports),
  ].join("\n");
}

export function driveMailboxMail(args: {
  parentProcessing: boolean;
  mailbox: FleetDryMailbox | undefined;
  lanes: readonly FleetDryLane[];
  beginSystemContinuation: (prompt: string) => void;
  send: (prompt: string) => unknown;
  onSendFailure?: () => void;
}): boolean {
  if (args.parentProcessing) return false;
  const reports = collectUncollectedTerminals(args.mailbox, args.lanes, false);
  if (reports.length === 0) return false;
  const prompt = buildMailboxMailPrompt(reports);
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
