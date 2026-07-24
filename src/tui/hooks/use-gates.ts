import { useEffect, useRef, useState } from "react";
import type { EventEmitter } from "node:events";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
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
};

export type ActiveApproval =
  | { id: number; kind: "plan"; plan: PlanStep[] }
  | { id: number; kind: "operator"; question: string; options: string[] }
  | { id: number; kind: "permission"; request: PermissionRequest; timeoutMs: number | null };

export type GateController = {
  activeApproval: ActiveApproval | null;
  /** Permission gates still queued, including the visible modal. */
  permissionQueueDepth: number;
  gateOpen: boolean;
  approve: (id: number) => void;
  reject: (id: number) => void;
  selectOperator: (id: number, result: OperatorResult) => void;
  resolvePermission: (id: number, outcome: ApprovalOutcome) => void;
  resetGates: () => void;
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

export function useGates({
  eventEmitter,
  setGatePending,
  activationBlocked = false,
}: UseGatesArgs): GateController {
  const [activeApproval, setActiveApproval] = useState<ActiveApproval | null>(null);
  const [permissionQueueDepth, setPermissionQueueDepth] = useState(0);
  const queue = useRef<GateQueueEntry[]>([]);
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

  function settleHead(id: number, kind: GateQueueEntry["kind"]): GateQueueEntry | null {
    const head = queue.current[0];
    if (head === undefined || head.id !== id || head.kind !== kind) return null;
    queue.current.shift();
    activeId.current = null;
    clearEntryTimer(head);
    if (head.kind === "permission") {
      setPermissionQueueDepth((depth) => depth - 1);
    }
    setGatePendingRef.current(false);
    updateVisibleEntry();
    return head;
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
    const entry = settleHead(id, "permission");
    if (entry?.kind === "permission") entry.resolve(outcome);
  }

  function enqueue(entry: GateQueueEntry): void {
    queue.current.push(entry);
    if (entry.kind === "permission") {
      setPermissionQueueDepth((depth) => depth + 1);
    }
    setGatePendingRef.current(true);
    if (queue.current.length === 1) updateVisibleEntry();
  }

  function drainQueue(): void {
    const remaining = queue.current.splice(0);
    activeId.current = null;
    setActiveApproval(null);
    setPermissionQueueDepth(0);
    for (const entry of remaining) clearEntryTimer(entry);
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
    const onPermission = ({ request, resolve, timeoutMs, timeoutMessage }: PermissionGateEvent) => {
      enqueue({
        id: nextId.current++,
        kind: "permission",
        request,
        resolve,
        timer: null,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
        ...(timeoutMessage !== undefined ? { timeoutMessage } : {}),
      });
    };

    eventEmitter.on("plan.gate", onPlan);
    eventEmitter.on("operator.gate", onOperator);
    eventEmitter.on("permission.gate", onPermission);
    return () => {
      eventEmitter.off("plan.gate", onPlan);
      eventEmitter.off("operator.gate", onOperator);
      eventEmitter.off("permission.gate", onPermission);
      drainQueue();
    };
    // Queue operations are ref-backed; listeners should only change with their emitter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventEmitter]);

  return {
    activeApproval,
    permissionQueueDepth,
    gateOpen: activeApproval !== null,
    approve: (id) => settlePlan(id, true),
    reject: (id) => settlePlan(id, false),
    selectOperator: settleOperator,
    resolvePermission: settlePermission,
    resetGates: drainQueue,
  };
}
