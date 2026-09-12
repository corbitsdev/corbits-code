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
  type FleetDryBlobWriter,
  type FleetDryLane,
  type FleetDryMailbox,
} from "./fleet-dry-drive.js";

export const MAILBOX_MAIL_WAKE_PREFIX = "mailbox mail";

/**
 * First-delivery instruction. Occupancy handed these reports to the parent;
 * do not call wait_agents. Must not say "already collected" — that makes the
 * first wake look like a replay.
 */
export function mailboxMailWakeLine(): string {
  return `${MAILBOX_MAIL_WAKE_PREFIX} — occupancy delivered these worker reports (do not call wait_agents for these agent_ids):`;
}

/**
 * Whether inbound text is occupancy's mailbox mail. Internal runtime→agent
 * traffic — the fleet board already owns worker status and the payload is
 * model-facing report JSON, so the transcript never paints it. Persisted
 * turns carry no message flags, so both the live event map and history
 * hydration must recognise it by content.
 */
export function isMailboxMailText(text: string): boolean {
  return text.startsWith(mailboxMailWakeLine());
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value;
}

/**
 * Ids occupancy has snapshotted and handed to send, but not yet taken.
 * A second flush must not start another parent turn for the same reports.
 * Failed send clears the set so a later flush can retry. Weak-keyed so a
 * mailbox object can go away without a leak.
 */
const deliveringByMailbox = new WeakMap<FleetDryMailbox, Set<string>>();

function deliveringSet(mailbox: FleetDryMailbox): Set<string> {
  let ids = deliveringByMailbox.get(mailbox);
  if (ids === undefined) {
    ids = new Set();
    deliveringByMailbox.set(mailbox, ids);
  }
  return ids;
}

function releaseDelivering(
  mailbox: FleetDryMailbox | undefined,
  ids: readonly string[],
): void {
  if (mailbox === undefined) return;
  const delivering = deliveringByMailbox.get(mailbox);
  if (delivering === undefined) return;
  for (const id of ids) delivering.delete(id);
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
  return [mailboxMailWakeLine(), JSON.stringify(reports)].join("\n");
}

export function driveMailboxMail(args: {
  parentProcessing: boolean;
  mailbox: FleetDryMailbox | undefined;
  lanes: readonly FleetDryLane[];
  writeBlob?: FleetDryBlobWriter;
  beginSystemContinuation: (prompt: string) => void;
  send: (prompt: string) => unknown;
  onSendFailure?: () => void;
}): boolean | Promise<boolean> {
  if (args.parentProcessing) return false;
  return driveMailboxMailAfterCollect(args);
}

async function driveMailboxMailAfterCollect(
  args: Parameters<typeof driveMailboxMail>[0],
): Promise<boolean> {
  const delivering =
    args.mailbox !== undefined
      ? deliveringSet(args.mailbox)
      : new Set<string>();
  const reports = (
    await collectUncollectedTerminals(
      args.mailbox,
      args.lanes,
      false,
      args.writeBlob,
    )
  ).filter((report) => !delivering.has(report.agent_id));
  if (reports.length === 0) return false;
  const ids = reports.map((report) => report.agent_id);
  for (const id of ids) delivering.add(id);
  const prompt = buildMailboxMailPrompt(reports);
  const takeReports = (): void => {
    for (const id of ids) {
      args.mailbox?.take(id);
    }
    releaseDelivering(args.mailbox, ids);
  };
  const fail = (): boolean => {
    releaseDelivering(args.mailbox, ids);
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
          else fail();
        },
        () => {
          fail();
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

/**
 * Store-subscribe, stall-poll, and idle-with-fleet settle all flush mailbox
 * mail. `driveMailboxMail` does not mark the parent busy until after an
 * awaited collect, so overlapping flushes would each call `send()` and fill
 * the agent's depth-16 queue. Hold one drive until that promise settles.
 */
export function latchMailboxMailDrive(
  drive: () => boolean | Promise<boolean>,
): () => boolean {
  let inFlight = false;
  return () => {
    if (inFlight) return false;
    const driven = drive();
    if (driven === false) return false;
    inFlight = true;
    void Promise.resolve(driven).finally(() => {
      inFlight = false;
    });
    return true;
  };
}
