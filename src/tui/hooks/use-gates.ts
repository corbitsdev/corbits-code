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

export type PendingOperator = { question: string; options: string[] };

export type GateController = {
  pendingPlan: PlanStep[] | null;
  pendingOperator: PendingOperator | null;
  pendingPermission: PermissionRequest | null;
  /** Permission gates still queued, including the visible modal. */
  permissionQueueDepth: number;
  /**
   * Auto-skip budget for the visible permission modal (goal mode). Null when the
   * head request has no timeout.
   */
  permissionTimeoutMs: number | null;
  gateOpen: boolean;
  approve: () => void;
  reject: () => void;
  selectOperator: (result: OperatorResult) => void;
  resolvePermission: (outcome: ApprovalOutcome) => void;
  resetGates: () => void;
};

export type UseGatesArgs = {
  eventEmitter: EventEmitter;
  setGatePending: (pending: boolean) => void;
};

type PlanQueueEntry = { plan: PlanStep[]; resolve: (approved: boolean) => void };
type OperatorQueueEntry = { question: string; options: string[]; resolve: (result: OperatorResult) => void };
type PermissionQueueEntry = {
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  timeoutMs?: number;
  timeoutMessage?: string;
  settled: boolean;
};

function settlePermission(entry: PermissionQueueEntry, outcome: ApprovalOutcome): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.resolve(outcome);
}

export function useGates({ eventEmitter, setGatePending }: UseGatesArgs): GateController {
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const [pendingOperator, setPendingOperator] = useState<PendingOperator | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [permissionQueueDepth, setPermissionQueueDepth] = useState(0);
  const [permissionTimeoutMs, setPermissionTimeoutMs] = useState<number | null>(null);

  const planQueue = useRef<PlanQueueEntry[]>([]);
  const operatorQueue = useRef<OperatorQueueEntry[]>([]);
  const permissionQueue = useRef<PermissionQueueEntry[]>([]);
  // Keep setGatePending stable for timer callbacks without re-binding listeners.
  const setGatePendingRef = useRef(setGatePending);
  setGatePendingRef.current = setGatePending;

  // Clock starts only when the request is the visible head — queued items must
  // not burn budget while the operator is still answering an earlier prompt.
  const armHeadTimeout = (entry: PermissionQueueEntry) => {
    if (entry.settled || entry.timer !== null) return;
    const timeoutMs = entry.timeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    const message = entry.timeoutMessage ?? goalApprovalTimeoutMessage(timeoutMs);
    entry.timer = setTimeout(() => {
      dropPermissionEntry(entry, { allow: false, message });
    }, timeoutMs);
  };

  const dropPermissionEntry = (entry: PermissionQueueEntry, outcome: ApprovalOutcome) => {
    const idx = permissionQueue.current.indexOf(entry);
    if (idx === -1 || entry.settled) return;
    permissionQueue.current.splice(idx, 1);
    if (idx === 0) {
      const next = permissionQueue.current[0] ?? null;
      setPendingPermission(next ? next.request : null);
      setPermissionTimeoutMs(next?.timeoutMs ?? null);
      if (next !== null) armHeadTimeout(next);
    }
    setPermissionQueueDepth(permissionQueue.current.length);
    setGatePendingRef.current(false);
    settlePermission(entry, outcome);
  };

  useEffect(() => {
    const handler = ({ plan, resolve }: PlanGateEvent) => {
      planQueue.current.push({ plan, resolve });
      if (planQueue.current.length === 1) setPendingPlan(plan);
      setGatePending(true);
    };
    eventEmitter.on("plan.gate", handler);
    return () => {
      eventEmitter.off("plan.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ question, options, resolve }: OperatorGateEvent) => {
      operatorQueue.current.push({ question, options, resolve });
      if (operatorQueue.current.length === 1) setPendingOperator({ question, options });
      setGatePending(true);
    };
    eventEmitter.on("operator.gate", handler);
    return () => {
      eventEmitter.off("operator.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ request, resolve, timeoutMs, timeoutMessage }: PermissionGateEvent) => {
      const entry: PermissionQueueEntry = {
        request,
        resolve,
        timer: null,
        settled: false,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
        ...(timeoutMessage !== undefined ? { timeoutMessage } : {}),
      };
      permissionQueue.current.push(entry);
      if (permissionQueue.current.length === 1) {
        setPendingPermission(request);
        setPermissionTimeoutMs(entry.timeoutMs ?? null);
        armHeadTimeout(entry);
      }
      setPermissionQueueDepth(permissionQueue.current.length);
      setGatePending(true);
    };
    eventEmitter.on("permission.gate", handler);
    return () => {
      eventEmitter.off("permission.gate", handler);
      // Tear down mid-flight: clear timers and deny remaining so promises settle.
      const remaining = permissionQueue.current.splice(0);
      for (const entry of remaining) {
        settlePermission(entry, { allow: false });
        setGatePendingRef.current(false);
      }
      setPendingPermission(null);
      setPermissionQueueDepth(0);
      setPermissionTimeoutMs(null);
    };
    // armHeadTimeout / dropPermissionEntry close over refs; intentional stable handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventEmitter, setGatePending]);

  const resolvePlanHead = (approved: boolean) => {
    const head = planQueue.current.shift();
    const next = planQueue.current[0] ?? null;
    setPendingPlan(next ? next.plan : null);
    setGatePending(false);
    head?.resolve(approved);
  };

  const resetGates = () => {
    const pendingCount =
      planQueue.current.length + operatorQueue.current.length + permissionQueue.current.length;
    for (const entry of planQueue.current) entry.resolve(false);
    planQueue.current = [];
    for (const entry of operatorQueue.current) entry.resolve({ kind: "cancel" });
    operatorQueue.current = [];
    for (const entry of permissionQueue.current) {
      settlePermission(entry, { allow: false });
    }
    permissionQueue.current = [];
    setPendingPlan(null);
    setPendingOperator(null);
    setPendingPermission(null);
    setPermissionQueueDepth(0);
    setPermissionTimeoutMs(null);
    for (let i = 0; i < pendingCount; i += 1) {
      setGatePending(false);
    }
  };

  return {
    pendingPlan,
    pendingOperator,
    pendingPermission,
    permissionQueueDepth,
    permissionTimeoutMs,
    gateOpen: pendingPlan !== null || pendingOperator !== null || pendingPermission !== null,
    approve: () => resolvePlanHead(true),
    reject: () => resolvePlanHead(false),
    selectOperator: (result: OperatorResult) => {
      const head = operatorQueue.current.shift();
      const next = operatorQueue.current[0] ?? null;
      setPendingOperator(next ? { question: next.question, options: next.options } : null);
      setGatePending(false);
      head?.resolve(result);
    },
    resolvePermission: (outcome: ApprovalOutcome) => {
      const head = permissionQueue.current[0];
      if (head === undefined) return;
      dropPermissionEntry(head, outcome);
    },
    resetGates,
  };
}
