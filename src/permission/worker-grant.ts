// Worker denied-call envelope (CL-9475 Phase 1): harness-owned sidecar for a
// worker tool call denied pending operator approval. The worker `deny` text
// keeps `deny` + WORKER_CANNOT_COMPLETE_APPROVAL wording and names only the
// envelope requestId; the envelope itself carries the exact denied call
// (tool/action/subject/args + stable hash, callId, worker session/cwd) so the
// parent replays the EXACT ToolCall through its own gate operator path and
// retries via the existing resume_agent verb with exact args + questionId ref.
// Model prose (ask_director text, send_input content) is never authoritative:
// nothing here parses message text, and plain send_input stays text-only.
// The dedicated atomic grant-and-retry verb is a Phase 2 follow-up.

import { createHash, randomUUID } from "node:crypto";

import type { ToolCall } from "@intx/types/runtime";

import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { stableRequestId } from "./denial-memory.js";

/** Wall-clock retry window: one denied call gets at most one granted retry
 * within ten minutes of the deny. turnId is metadata only — no turn
 * enforcement exists, so expiry is purely expiresAt-driven. */
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
  /** Exact denied arguments, JSON-cloned at deny time. */
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

/** Stable path-aware fingerprint: same normalization the gate's denial memory
 * uses (relative path args resolve against cwd), hashed to a fixed id.
 * Object keys sort first so a retried call with reordered keys still matches
 * the exact denied call. */
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

/** Deny reason keeps `deny` + WORKER_CANNOT_COMPLETE_APPROVAL text and names
 * only the envelope requestId — the worker's ask_director text must reference
 * that id and carries no authority. */
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
  /** Per-key async mutex chains: each entry resolves when its holder's turn
   * ends, so waiters FIFO through the precheck-to-consume gap. */
  private readonly turns = new Map<string, Promise<void>>();

  /** Serialize concurrent identical worker retries across the
   * precheck-to-consume gap: without this, two in-flight copies of the exact
   * call both pass precheck before either consumes, and the gate allows both
   * — two executions for one envelope. The key must cover the envelope match
   * (session + tool/args/cwd fingerprint). Non-reentrant: fn must not call
   * runExclusive with the same key. */
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

  /** Still-pending envelope for the same exact denied call (dedupes reactor
   * retries that mint fresh call ids for the same tool + normalized args).
   * Sweeps overdue envelopes first so a lapse can never read as pending. */
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

  /** Attach the harness envelope to the worker's ask_director record: stamps
   * the questionId so the parent's retry references it. When the ask names
   * its denial (the grant requestId quoted from the deny reason), bind that
   * exact envelope — first-pending-wins would join question-about-B to
   * exact-call-A when two denies share a session, poisoning the audit and
   * (Phase 2) replaying the wrong call. A named id that resolves to no
   * pending own-session envelope fails closed with no attach (never falls
   * back to another denial). An unnamed ask keeps the legacy first-pending
   * bind for the single-deny case. Sweeps overdue envelopes first: an ask
   * can never join an expired denial. */
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
   * Execution backstop pre-check for a worker call: fail closed when the exact
   * call identity matches a terminal envelope (replay, interrupt) or a
   * tampered cwd. Envelopes from other sessions never veto this session:
   * each session mints and spends its own envelope through its own grant
   * round. An EXPIRED envelope is
   * marked and skipped instead of denying: the lapsed window must yield a
   * fresh gate round that mints a fresh envelope, never a blackhole the
   * worker can never re-ask out of. Pending own envelopes and unknown calls
   * return ok and continue down the normal gate path — prose and send_input
   * text never reach this check as authority.
   * The cwd anchor binds the retry to the denied cwd: a covering session grant
   * is not cwd-scoped, so without this check the same args from another
   * directory would ride the parent's approval.
   */
  precheck(
    identity: WorkerCallIdentity,
  ): { ok: true } | { ok: false; blocker: string } {
    const now = identity.now ?? Date.now();
    this.sweepExpired(now);
    const fingerprint = fingerprintOf(identity);
    for (const envelope of this.envelopes.values()) {
      if (envelope.argsFingerprint !== fingerprint) continue;
      // Another session's envelope never vetoes this session: each session
      // mints and spends its own envelope through its own grant round, so a
      // sibling's pending or already-consumed envelope is irrelevant here.
      // (Reactor retries share the worker's session, so consume-once within
      // the session survives this scoping. Spending stays session-scoped in
      // consumeOnAllow, and tampered args/cwd still fail closed below.)
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
    // Phase 2 (by design, do not tighten here): a call whose fingerprint
    // matches no envelope falls through to the normal gate path, where a
    // broad parent session grant can cover more than the exact denied
    // subject. Binding the grant to the envelope args needs the dedicated
    // atomic grant-and-retry verb.
    return { ok: true };
  }

  /**
   * Consume the pending own-session envelope when the exact call is allowed
   * (the parent's operator grant now covers it): exactly one retry per
   * requestId. Returns the consumed envelope, or undefined when no pending
   * envelope matches (normal allow, nothing to consume).
   */
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
   * replay fails closed with a truthful blocker instead of falling through
   * to whatever grant the gate now holds. Retained completion keeps pending
   * envelopes — the retained resume_agent retry is the Phase 1 retry path. */
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

  /** Lazy-expiry engine: marks overdue pending envelopes expired with an
   * audit event. Every pendency read (precheck, pendingMatch,
   * pendingForSession, attachToAsk) sweeps through here so a lapsed window
   * can never read as pending; no periodic scheduler exists, and none is
   * needed while every read enforces the TTL. */
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

/** Process-shared sidecar: the worker deny side registers, the parent
 * observes/consumes — same single-use truth, no message-text authority. */
export function getProcessWorkerGrantStore(): WorkerGrantStore {
  if (processStore === undefined) processStore = new WorkerGrantStore();
  return processStore;
}
