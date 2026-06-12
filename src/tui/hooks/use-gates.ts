import { useEffect, useRef, useState } from "react";
import type { EventEmitter } from "node:events";
import type { PlanStep } from "../use-stream.js";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";

export type PlanGateEvent = {
  plan: PlanStep[];
  resolve: (approved: boolean) => void;
};

export type OperatorGateEvent = {
  question: string;
  options: string[];
  resolve: (index: number) => void;
};

export type PermissionGateEvent = {
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
};

export type PendingOperator = { question: string; options: string[] };

export type GateController = {
  pendingPlan: PlanStep[] | null;
  pendingOperator: PendingOperator | null;
  pendingPermission: PermissionRequest | null;
  gateOpen: boolean;
  approve: () => void;
  reject: () => void;
  selectOperator: (index: number) => void;
  resolvePermission: (outcome: ApprovalOutcome) => void;
  // Drain all queued gates, resolving each with a safe default, and clear
  // visible state. Called on session rotation so stale modals do not persist.
  resetGates: () => void;
};

export type UseGatesArgs = {
  eventEmitter: EventEmitter;
  setGatePending: (pending: boolean) => void;
};

// Each queued entry bundles the display payload with its resolve callback so
// we can advance to the next item after the head is resolved.
type PlanQueueEntry = { plan: PlanStep[]; resolve: (approved: boolean) => void };
type OperatorQueueEntry = { question: string; options: string[]; resolve: (index: number) => void };
type PermissionQueueEntry = { request: PermissionRequest; resolve: (outcome: ApprovalOutcome) => void };

export function useGates({ eventEmitter, setGatePending }: UseGatesArgs): GateController {
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const [pendingOperator, setPendingOperator] = useState<PendingOperator | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  // FIFO queues — one per gate type. The head entry is what's currently shown.
  const planQueue = useRef<PlanQueueEntry[]>([]);
  const operatorQueue = useRef<OperatorQueueEntry[]>([]);
  const permissionQueue = useRef<PermissionQueueEntry[]>([]);

  useEffect(() => {
    const handler = ({ plan, resolve }: PlanGateEvent) => {
      planQueue.current.push({ plan, resolve });
      // Only update visible state when this is the first (head) entry; later
      // entries stay invisible until the head resolves.
      if (planQueue.current.length === 1) {
        setPendingPlan(plan);
      }
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
      if (operatorQueue.current.length === 1) {
        setPendingOperator({ question, options });
      }
      setGatePending(true);
    };
    eventEmitter.on("operator.gate", handler);
    return () => {
      eventEmitter.off("operator.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ request, resolve }: PermissionGateEvent) => {
      permissionQueue.current.push({ request, resolve });
      if (permissionQueue.current.length === 1) {
        setPendingPermission(request);
      }
      setGatePending(true);
    };
    eventEmitter.on("permission.gate", handler);
    return () => {
      eventEmitter.off("permission.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  const resolvePlan = (approved: boolean) => {
    const head = planQueue.current.shift();
    const next = planQueue.current[0] ?? null;
    // Advance display to the next queued gate, or clear when the queue empties.
    setPendingPlan(next ? next.plan : null);
    setGatePending(false);
    head?.resolve(approved);
  };

  const resetGates = () => {
    for (const entry of planQueue.current) entry.resolve(false);
    planQueue.current = [];
    for (const entry of operatorQueue.current) entry.resolve(0);
    operatorQueue.current = [];
    for (const entry of permissionQueue.current) entry.resolve({ allow: false });
    permissionQueue.current = [];
    setPendingPlan(null);
    setPendingOperator(null);
    setPendingPermission(null);
    setGatePending(false);
  };

  return {
    pendingPlan,
    pendingOperator,
    pendingPermission,
    gateOpen: pendingPlan !== null || pendingOperator !== null || pendingPermission !== null,
    approve: () => resolvePlan(true),
    reject: () => resolvePlan(false),
    selectOperator: (index: number) => {
      const head = operatorQueue.current.shift();
      const next = operatorQueue.current[0] ?? null;
      setPendingOperator(next ? { question: next.question, options: next.options } : null);
      setGatePending(false);
      head?.resolve(index);
    },
    resolvePermission: (outcome: ApprovalOutcome) => {
      const head = permissionQueue.current.shift();
      const next = permissionQueue.current[0] ?? null;
      setPendingPermission(next ? next.request : null);
      setGatePending(false);
      head?.resolve(outcome);
    },
    resetGates,
  };
}
