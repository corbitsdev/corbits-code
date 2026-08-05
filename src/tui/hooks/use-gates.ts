import { useEffect, useRef, useState } from "react";
import type { EventEmitter } from "node:events";
import type { Approval, ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import type { OperatorResult } from "../../agent/tools.js";
import type { PlanStep } from "../use-stream.js";
import { goalApprovalTimeoutMessage } from "../../permission/goal-approval-timeout.js";


export type PlanGateEvent = {
  plan: PlanStep[];
  resolve: (approved: boolean) => void;
};

export type OperatorGateEvent = {
  question: string;
  options: string[];
  resolve: (result: OperatorResult) => void;
};

export type PermissionGateEvent = {
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  /**
   * When set (goal mode active), auto-deny if the operator has not answered
   * within this many ms so an unattended goal cannot park on the modal forever.
   */
  timeoutMs?: number;
  /** Override the agent-facing deny message on timeout. */
  timeoutMessage?: string;
  /**
   * Tool-execution budget signal. When aborted (watchdog timeout or parent
   * cancel), this permission entry is auto-denied even if it is not the head
   * of the queue — so the modal cannot outlive a tool that already finished.
   */
  signal?: AbortSignal;
};

export type ActiveApproval =
  | { id: number; kind: "plan"; plan: PlanStep[] }
  | { id: number; kind: "operator"; question: string; options: string[] }
  | { id: number; kind: "permission"; request: PermissionRequest; timeoutMs: number | null };

// One line per queued (not just visible) permission request, so the modal can
// show that other approvals are waiting and which agent each belongs to —
// distinct agentLabel values render as visually distinct entries.
export type QueuedApprovalSummary = { id: number; tool: string; agentLabel?: string };

export type GateController = {
  activeApproval: ActiveApproval | null;
  /** Permission gates still queued, including the visible modal. */
  permissionQueueDepth: number;
  /** Summary of every queued (not just visible) permission request. */
  queuedApprovals: readonly QueuedApprovalSummary[];
  gateOpen: boolean;
  approve: (id: number) => void;
  reject: (id: number) => void;
  selectOperator: (id: number, result: OperatorResult) => void;
  resolvePermission: (id: number, outcome: ApprovalOutcome) => void;
  resetGates: () => void;
};

// Fired synchronously by the permission gate right after a grant is minted
// (see PermissionGateOptions.onGrant) so the queue can drop any already-queued
// requests the new grant now covers, before the next prompt renders.
export type PermissionGrantEvent = {
  approval: Approval;
  // Supplied by the gate so coverage is judged against the gate's own path
  // restriction; the hook must never re-derive it from a request's cwd.
  covers: (request: PermissionRequest) => boolean;
};

export type UseGatesArgs = {
  eventEmitter: EventEmitter;
  setGatePending: (pending: boolean) => void;
  activationBlocked?: boolean;
};

type PlanQueueEntry = {
  id: number;
  kind: "plan";
  plan: PlanStep[];
  resolve: (approved: boolean) => void;
};

type OperatorQueueEntry = {
  id: number;
  kind: "operator";
  question: string;
  options: string[];
  resolve: (result: OperatorResult) => void;
};

type PermissionQueueEntry = {
  id: number;
  kind: "permission";
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  timeoutMs?: number;
  timeoutMessage?: string;
  /** Detach budget-abort listener when the entry settles. */
  detachAbort: (() => void) | null;
};

type GateQueueEntry = PlanQueueEntry | OperatorQueueEntry | PermissionQueueEntry;

function toActiveApproval(entry: GateQueueEntry): ActiveApproval {
  switch (entry.kind) {
    case "plan":
      return { id: entry.id, kind: entry.kind, plan: entry.plan };
    case "operator":
      return { id: entry.id, kind: entry.kind, question: entry.question, options: entry.options };
    case "permission":
      return {
        id: entry.id,
        kind: entry.kind,
        request: entry.request,
        timeoutMs: entry.timeoutMs ?? null,
      };
  }
}

function clearEntryTimer(entry: GateQueueEntry): void {
  if (entry.kind !== "permission" || entry.timer === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
}

function detachEntryAbort(entry: GateQueueEntry): void {
  if (entry.kind !== "permission") return;
  entry.detachAbort?.();
  entry.detachAbort = null;
}

export function useGates({
  eventEmitter,
  setGatePending,
  activationBlocked = false,
}: UseGatesArgs): GateController {
  const [activeApproval, setActiveApproval] = useState<ActiveApproval | null>(null);
  const [queuedApprovals, setQueuedApprovals] = useState<readonly QueuedApprovalSummary[]>([]);
  const queue = useRef<GateQueueEntry[]>([]);
  // Depth is the length of the permission summary list — one source of truth.
  const permissionQueueDepth = queuedApprovals.length;

  function syncQueuedApprovals(): void {
    setQueuedApprovals(
      queue.current
        .filter((e): e is PermissionQueueEntry => e.kind === "permission")
        .map((e) => ({
          id: e.id,
          tool: e.request.tool,
          ...(e.request.agentLabel !== undefined ? { agentLabel: e.request.agentLabel } : {}),
        })),
    );
  }
  const nextId = useRef(1);
  const activeId = useRef<number | null>(null);
  const activationBlockedRef = useRef(activationBlocked);
  const setGatePendingRef = useRef(setGatePending);
  activationBlockedRef.current = activationBlocked;
  setGatePendingRef.current = setGatePending;

  function updateVisibleEntry(): void {
    const head = queue.current[0];
    if (head === undefined) {
      activeId.current = null;
      setActiveApproval(null);
      return;
    }
    if (activeId.current === null && activationBlockedRef.current) {
      setActiveApproval(null);
      return;
    }
    activeId.current = head.id;
    setActiveApproval(toActiveApproval(head));
    if (head.kind !== "permission" || head.timer !== null) return;
    const timeoutMs = head.timeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    const message = head.timeoutMessage ?? goalApprovalTimeoutMessage(timeoutMs);
    head.timer = setTimeout(() => {
      settlePermission(head.id, { allow: false, message });
    }, timeoutMs);
  }

  /**
   * Remove a queue entry by id (even if not head). Used when a tool budget
   * aborts while its permission prompt is still waiting behind another gate.
   */
  function removeEntry(id: number, kind: GateQueueEntry["kind"]): GateQueueEntry | null {
    const index = queue.current.findIndex((e) => e.id === id && e.kind === kind);
    if (index === -1) return null;
    const [entry] = queue.current.splice(index, 1);
    if (entry === undefined) return null;
    clearEntryTimer(entry);
    detachEntryAbort(entry);
    if (entry.kind === "permission") {
      syncQueuedApprovals();
    }
    setGatePendingRef.current(false);
    if (index === 0) {
      activeId.current = null;
      updateVisibleEntry();
    }
    return entry;
  }

  function settleHead(id: number, kind: GateQueueEntry["kind"]): GateQueueEntry | null {
    const head = queue.current[0];
    if (head === undefined || head.id !== id || head.kind !== kind) return null;
    return removeEntry(id, kind);
  }

  function settlePlan(id: number, approved: boolean): void {
    const entry = settleHead(id, "plan");
    if (entry?.kind === "plan") entry.resolve(approved);
  }

  function settleOperator(id: number, result: OperatorResult): void {
    const entry = settleHead(id, "operator");
    if (entry?.kind === "operator") entry.resolve(result);
  }

  function settlePermission(id: number, outcome: ApprovalOutcome): void {
    // Prefer head settle for the normal modal path; fall back to by-id so a
    // budget abort can dismiss a non-head permission still in the queue.
    const entry = settleHead(id, "permission") ?? removeEntry(id, "permission");
    if (entry?.kind === "permission") entry.resolve(outcome);
  }

  // Re-evaluate every still-queued permission entry against a newly-minted
  // grant. Requests it now covers are auto-approved and removed without
  // rendering a prompt for them. Runs against a snapshot of the queue so
  // settling entries mid-loop never skips or double-visits one.
  function reconcileQueue(covers: (request: PermissionRequest) => boolean): void {
    const snapshot = queue.current.filter(
      (entry): entry is PermissionQueueEntry => entry.kind === "permission",
    );
    for (const entry of snapshot) {
      if (!covers(entry.request)) continue;
      settlePermission(entry.id, { allow: true });
    }
  }

  function enqueue(entry: GateQueueEntry): void {
    queue.current.push(entry);
    if (entry.kind === "permission") {
      syncQueuedApprovals();
    }
    setGatePendingRef.current(true);
    if (queue.current.length === 1) updateVisibleEntry();
  }

  function drainQueue(): void {
    const remaining = queue.current.splice(0);
    activeId.current = null;
    setActiveApproval(null);
    setQueuedApprovals([]);
    for (const entry of remaining) {
      clearEntryTimer(entry);
      detachEntryAbort(entry);
    }
    for (const entry of remaining) {
      setGatePendingRef.current(false);
      switch (entry.kind) {
        case "plan":
          entry.resolve(false);
          break;
        case "operator":
          entry.resolve({ kind: "cancel" });
          break;
        case "permission":
          entry.resolve({ allow: false });
          break;
      }
    }
  }

  useEffect(() => {
    if (!activationBlocked && activeId.current === null && queue.current.length > 0) {
      updateVisibleEntry();
    }
    // Queue state is ref-backed; promotion only reacts to blocker transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationBlocked]);

  useEffect(() => {
    const onPlan = ({ plan, resolve }: PlanGateEvent) => {
      enqueue({ id: nextId.current++, kind: "plan", plan, resolve });
    };
    const onOperator = ({ question, options, resolve }: OperatorGateEvent) => {
      enqueue({ id: nextId.current++, kind: "operator", question, options, resolve });
    };
    const onPermission = ({
      request,
      resolve,
      timeoutMs,
      timeoutMessage,
      signal,
    }: PermissionGateEvent) => {
      const id = nextId.current++;
      const entry: PermissionQueueEntry = {
        id,
        kind: "permission",
        request,
        resolve,
        timer: null,
        detachAbort: null,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
        ...(timeoutMessage !== undefined ? { timeoutMessage } : {}),
      };
      if (signal !== undefined) {
        const onAbort = (): void => {
          settlePermission(id, {
            allow: false,
            message: "tool timed out or was cancelled while waiting for approval",
          });
        };
        if (signal.aborted) {
          // Already dead — still enqueue then settle so gatePending balances.
          enqueue(entry);
          settlePermission(id, {
            allow: false,
            message: "tool timed out or was cancelled while waiting for approval",
          });
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      enqueue(entry);
    };

    const onGrant = ({ covers }: PermissionGrantEvent) => {
      reconcileQueue(covers);
    };

    eventEmitter.on("plan.gate", onPlan);
    eventEmitter.on("operator.gate", onOperator);
    eventEmitter.on("permission.gate", onPermission);
    eventEmitter.on("permission.grant", onGrant);
    return () => {
      eventEmitter.off("plan.gate", onPlan);
      eventEmitter.off("operator.gate", onOperator);
      eventEmitter.off("permission.gate", onPermission);
      eventEmitter.off("permission.grant", onGrant);
      drainQueue();
    };
    // Queue operations are ref-backed; listeners should only change with their emitter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventEmitter]);

  return {
    activeApproval,
    permissionQueueDepth,
    queuedApprovals,
    gateOpen: activeApproval !== null,
    approve: (id) => settlePlan(id, true),
    reject: (id) => settlePlan(id, false),
    selectOperator: settleOperator,
    resolvePermission: settlePermission,
    resetGates: drainQueue,
  };
}
