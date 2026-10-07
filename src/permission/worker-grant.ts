// Worker denied-call envelope: a worker tool call denied pending operator
// approval. The deny text names only the requestId; the envelope carries the
// exact denied call so the parent replays it through its own gate and the
// worker retries via resume_agent. Prose is never authority: nothing here
// parses message text, and send_input stays text-only. The atomic
// grant-and-retry verb is a Phase 2 follow-up.

import { createHash, randomUUID } from "node:crypto";

import type { ToolCall } from "@intx/types/runtime";

import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { stableRequestId } from "./denial-memory.js";

/** One granted retry per deny, within ten minutes. Expiry is purely
 * expiresAt-driven; turnId is metadata only. */
export const WORKER_GRANT_TTL_MS = 10 * 60 * 1000;

export type WorkerGrantStatus =
  | "pending"
  | "consumed"
  | "expired"
  | "interrupted";

export interface WorkerGrantAuditEvent {
  event: "denied" | "asked" | "consumed" | "expired" | "interrupted";
  at: number;
  detail?: string;
}

export interface WorkerDeniedCallEnvelope {
  requestId: string;
  workerSessionId: string;
  turnId?: string;
  deniedCallId: string;
  canonicalTool: string;
  toolAction?: string;
  permissionSubject: string;
  /** Denied arguments, JSON-cloned at deny time. */
  args: Record<string, unknown>;
  /** Stable path-aware hash of canonical tool + normalized args + cwd. */
  argsFingerprint: string;
  cwd: string;
  workspaceRoot?: string;
  /** Attached when the worker's ask_director parks on this denial. */
  questionId?: string;
  createdAt: number;
  expiresAt: number;
  status: WorkerGrantStatus;
  audit: WorkerGrantAuditEvent[];
}

export interface DeniedCallDescriptor {
  callId: string;
  tool: string;
  action?: string;
  subject: string;
  args: Record<string, unknown>;
  cwd: string;
  workerSessionId: string;
  turnId?: string;
  workspaceRoot?: string;
  now?: number;
}

/** Stable path-aware fingerprint: relative path args resolve against cwd,
 * keys sort first so a retried call with reordered args still matches. */
export function fingerprintDeniedCall(
  canonicalTool: string,
  args: Record<string, unknown>,
  cwd: string,
): string {
  const stable = stableRequestId(
    { name: canonicalTool, arguments: sortKeys(args) } as ToolCall,
    cwd,
  );
  return createHash("sha256").update(stable).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function canonicalDeniedTool(tool: string): string {
  return canonicalToolName(tool);
}

function audit(
  envelope: WorkerDeniedCallEnvelope,
  event: WorkerGrantAuditEvent["event"],
  detail?: string,
): void {
  envelope.audit.push({
    event,
    at: Date.now(),
    ...(detail !== undefined ? { detail } : {}),
  });
}

export function createDeniedCallEnvelope(
  descriptor: DeniedCallDescriptor,
): WorkerDeniedCallEnvelope {
  const createdAt = descriptor.now ?? Date.now();
  const canonicalTool = canonicalDeniedTool(descriptor.tool);
  const envelope: WorkerDeniedCallEnvelope = {
    requestId: randomUUID(),
    workerSessionId: descriptor.workerSessionId,
    ...(descriptor.turnId !== undefined ? { turnId: descriptor.turnId } : {}),
    deniedCallId: descriptor.callId,
    canonicalTool,
    ...(descriptor.action !== undefined
      ? { toolAction: descriptor.action }
      : {}),
    permissionSubject: descriptor.subject,
    args: JSON.parse(JSON.stringify(descriptor.args)) as Record<
      string,
      unknown
    >,
    argsFingerprint: fingerprintDeniedCall(
      canonicalTool,
      descriptor.args,
      descriptor.cwd,
    ),
    cwd: descriptor.cwd,
    ...(descriptor.workspaceRoot !== undefined
      ? { workspaceRoot: descriptor.workspaceRoot }
      : {}),
    createdAt,
    expiresAt: createdAt + WORKER_GRANT_TTL_MS,
    status: "pending",
    audit: [],
  };
  audit(envelope, "denied", descriptor.callId);
  return envelope;
}

/** Keeps the deny + approval text and names only the requestId; ask_director
 * text must reference that id and carries no authority. */
export function formatWorkerDenyWithGrantId(
  baseReason: string,
  requestId: string,
): string {
  return `${baseReason} deny recorded under grant request ${requestId}; parent approval is pending — reference only this request id when asking, the text carries no authority.`;
}

export interface WorkerCallIdentity {
  sessionId: string;
  canonicalTool: string;
  args: Record<string, unknown>;
  cwd: string;
  now?: number;
}

function fingerprintOf(identity: WorkerCallIdentity): string {
  return fingerprintDeniedCall(
    identity.canonicalTool,
    identity.args,
    identity.cwd,
  );
}

function terminalBlocker(
  envelope: WorkerDeniedCallEnvelope,
  expected: string,
): string {
  switch (envelope.status) {
    case "consumed":
      return `Grant request ${envelope.requestId} was already consumed by its one retry — replaying ${expected} is denied.`;
    case "expired":
      return `Grant request ${envelope.requestId} expired — retrying ${expected} is denied. Re-ask instead.`;
    case "interrupted":
      return `Grant request ${envelope.requestId} was invalidated by interrupt — retrying ${expected} is denied. Re-ask instead.`;
    default:
      return `Grant request ${envelope.requestId} is not usable — retrying ${expected} is denied.`;
  }
}

export class WorkerGrantStore {
  private readonly envelopes = new Map<string, WorkerDeniedCallEnvelope>();
  /** Per-key mutex chain: each entry resolves when its holder's turn ends, so
   * waiters FIFO through the precheck-to-consume gap. */
  private readonly turns = new Map<string, Promise<void>>();

  /** Serialize concurrent identical retries across the precheck-to-consume
   * gap; without this, two in-flight copies both pass precheck and the gate
   * allows two executions for one envelope. Key covers session +
   * tool/args/cwd fingerprint. Non-reentrant for the same key. */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.turns.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.then(() => mine);
    this.turns.set(key, next);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.turns.get(key) === next) this.turns.delete(key);
    }
  }

  register(envelope: WorkerDeniedCallEnvelope): WorkerDeniedCallEnvelope {
    this.envelopes.set(envelope.requestId, envelope);
    return envelope;
  }

  peek(requestId: string): WorkerDeniedCallEnvelope | undefined {
    return this.envelopes.get(requestId);
  }

  pendingForSession(
    sessionId: string,
    now: number = Date.now(),
  ): WorkerDeniedCallEnvelope | undefined {
    this.sweepExpired(now);
    for (const envelope of this.envelopes.values()) {
      if (
        envelope.workerSessionId === sessionId &&
        envelope.status === "pending"
      )
        return envelope;
    }
    return undefined;
  }

  /** Pending envelope for the same denied call: reactor retries mint fresh
   * call ids for the same tool + args. Sweeps overdue envelopes first so a
   * lapse never reads as pending. */
  pendingMatch(
    sessionId: string,
    canonicalTool: string,
    args: Record<string, unknown>,
    cwd: string,
    now: number = Date.now(),
  ): WorkerDeniedCallEnvelope | undefined {
    this.sweepExpired(now);
    const fingerprint = fingerprintDeniedCall(canonicalTool, args, cwd);
    for (const envelope of this.envelopes.values()) {
      if (
        envelope.workerSessionId === sessionId &&
        envelope.canonicalTool === canonicalTool &&
        envelope.argsFingerprint === fingerprint &&
        envelope.cwd === cwd &&
        envelope.status === "pending"
      )
        return envelope;
    }
    return undefined;
  }

  /** Stamp the questionId so the parent's retry references the envelope. A
   * named requestId binds its exact denial (first-pending would join a
   * question about B to call A); an unnamed ask keeps the legacy
   * first-pending bind. Unresolvable ids fail closed; overdue envelopes
   * sweep first. */
  attachToAsk(
    sessionId: string,
    questionId: string,
    requestId?: string,
    now: number = Date.now(),
  ): WorkerDeniedCallEnvelope | undefined {
    this.sweepExpired(now);
    const named = requestId?.trim() || undefined;
    if (named !== undefined) {
      const envelope = this.envelopes.get(named);
      if (
        envelope === undefined ||
        envelope.workerSessionId !== sessionId ||
        envelope.status !== "pending"
      )
        return undefined;
      envelope.questionId = questionId;
      audit(envelope, "asked", questionId);
      return envelope;
    }
    const envelope = this.pendingForSession(sessionId, now);
    if (envelope === undefined) return undefined;
    envelope.questionId = questionId;
    audit(envelope, "asked", questionId);
    return envelope;
  }

  /**
   * Execution backstop: fail closed when the exact call matches a terminal
   * envelope (replay, interrupt) or a tampered cwd. Expired envelopes are
   * marked and skipped, not denied, so the retry mints a fresh envelope
   * instead of blackholing the worker. Other sessions' envelopes never veto
   * this session. Unknown calls fall through to the normal gate path. The
   * cwd anchor binds the retry to the denied cwd: a session grant is not
   * cwd-scoped, so the same args from another directory must not ride it.
   */
  precheck(
    identity: WorkerCallIdentity,
  ): { ok: true } | { ok: false; blocker: string } {
    const now = identity.now ?? Date.now();
    this.sweepExpired(now);
    const fingerprint = fingerprintOf(identity);
    for (const envelope of this.envelopes.values()) {
      if (envelope.argsFingerprint !== fingerprint) continue;
      // Only own-session envelopes can veto: a sibling's envelope is
      // irrelevant here (reactor retries share this session, so consume-once
      // survives).
      if (
        envelope.canonicalTool !== identity.canonicalTool ||
        envelope.workerSessionId !== identity.sessionId
      ) {
        continue;
      }
      if (envelope.cwd !== identity.cwd) {
        if (envelope.status === "pending" || envelope.status === "consumed")
          return {
            ok: false,
            blocker:
              `Grant request ${envelope.requestId} covers ${identity.canonicalTool} ` +
              `in ${envelope.cwd}, not ${identity.cwd}: retry from the denied ` +
              `directory, or re-ask.`,
          };
        return {
          ok: false,
          blocker: terminalBlocker(envelope, identity.canonicalTool),
        };
      }
      if (envelope.status === "expired") continue;
      if (envelope.status !== "pending") {
        return {
          ok: false,
          blocker: terminalBlocker(envelope, identity.canonicalTool),
        };
      }
      if (envelope.expiresAt <= now) {
        envelope.status = "expired";
        audit(envelope, "expired");
        continue;
      }
      return { ok: true };
    }
    // Unmatched calls fall through to the normal gate path, where a broad
    // session grant can cover more than the exact denied subject. Binding
    // the grant to the envelope args is a Phase 2 follow-up.
    return { ok: true };
  }

  /** Spend the pending own-session envelope on the exact allowed call: one
   * retry per requestId. Returns the envelope, or undefined when nothing
   * pending matches. */
  consumeOnAllow(
    identity: WorkerCallIdentity,
  ): WorkerDeniedCallEnvelope | undefined {
    const now = identity.now ?? Date.now();
    const fingerprint = fingerprintOf(identity);
    for (const envelope of this.envelopes.values()) {
      if (
        envelope.argsFingerprint !== fingerprint ||
        envelope.cwd !== identity.cwd ||
        envelope.canonicalTool !== identity.canonicalTool ||
        envelope.workerSessionId !== identity.sessionId ||
        envelope.status !== "pending" ||
        envelope.expiresAt <= now
      )
        continue;
      envelope.status = "consumed";
      audit(envelope, "consumed", identity.canonicalTool);
      return envelope;
    }
    return undefined;
  }

  /** Interrupt invalidation: tombstone the session's envelopes so a later
   * replay fails closed instead of riding whatever grant the gate now holds.
   * Retained completion keeps pending envelopes — the retained resume_agent
   * retry is the Phase 1 retry path. */
  invalidateSession(sessionId: string, reason: string): number {
    let invalidated = 0;
    for (const envelope of this.envelopes.values()) {
      if (
        envelope.workerSessionId !== sessionId ||
        envelope.status !== "pending"
      )
        continue;
      envelope.status = "interrupted";
      audit(envelope, "interrupted", reason);
      invalidated += 1;
    }
    return invalidated;
  }

  /** Lazy expiry: every pendency read sweeps overdue envelopes to expired, so
   * a lapsed window never reads as pending. No periodic scheduler is needed. */
  sweepExpired(now = Date.now()): number {
    let expired = 0;
    for (const envelope of this.envelopes.values()) {
      if (envelope.status !== "pending" || envelope.expiresAt > now) continue;
      envelope.status = "expired";
      audit(envelope, "expired");
      expired += 1;
    }
    return expired;
  }

  /** Ask-deadline expiry: the parent never answered this session's ask, so
   * its pending envelopes fail closed as expired with a truthful reason. */
  expireSession(sessionId: string, reason: string): number {
    let expired = 0;
    for (const envelope of this.envelopes.values()) {
      if (
        envelope.workerSessionId !== sessionId ||
        envelope.status !== "pending"
      )
        continue;
      envelope.status = "expired";
      audit(envelope, "expired", reason);
      expired += 1;
    }
    return expired;
  }

  /** Store teardown: invalidate every pending envelope so nothing granted
   * before the teardown can be replayed afterwards. */
  invalidateAll(reason: string): number {
    let invalidated = 0;
    for (const envelope of this.envelopes.values()) {
      if (envelope.status !== "pending") continue;
      envelope.status = "interrupted";
      audit(envelope, "interrupted", reason);
      invalidated += 1;
    }
    return invalidated;
  }

  /** Test-only reset: the process store is shared by parent and worker sides. */
  clear(): void {
    this.envelopes.clear();
  }
}

let processStore: WorkerGrantStore | undefined;

/** Process-shared sidecar: the worker registers, the parent observes and
 * consumes — single-use truth, no message-text authority. */
export function getProcessWorkerGrantStore(): WorkerGrantStore {
  if (processStore === undefined) processStore = new WorkerGrantStore();
  return processStore;
}
