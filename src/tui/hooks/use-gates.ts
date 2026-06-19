import { useEffect, useRef, useState } from "react";
import type { EventEmitter } from "node:events";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import type { OperatorResult } from "../../agent/tools.js";
import type { PlanStep } from "../use-stream.js";

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
};

export type PendingOperator = { question: string; options: string[] };

export type GateController = {
  pendingPlan: PlanStep[] | null;
  pendingOperator: PendingOperator | null;
  pendingPermission: PermissionRequest | null;
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
type PermissionQueueEntry = { request: PermissionRequest; resolve: (outcome: ApprovalOutcome) => void };

export function useGates({ eventEmitter, setGatePending }: UseGatesArgs): GateController {
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const [pendingOperator, setPendingOperator] = useState<PendingOperator | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  const planQueue = useRef<PlanQueueEntry[]>([]);
  const operatorQueue = useRef<OperatorQueueEntry[]>([]);
  const permissionQueue = useRef<PermissionQueueEntry[]>([]);

  useEffect(() => {
    const handler = ({ plan, resolve }: PlanGateEvent) => {
      planQueue.current.push({ plan, resolve });
      if (planQueue.current.length === 1) setPendingPlan(plan);
      setGatePending(true);
    };
    eventEmitter.on("plan.gate", handler);
    return () => { eventEmitter.off("plan.gate", handler); };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ question, options, resolve }: OperatorGateEvent) => {
      operatorQueue.current.push({ question, options, resolve });
      if (operatorQueue.current.length === 1) setPendingOperator({ question, options });
      setGatePending(true);
    };
    eventEmitter.on("operator.gate", handler);
    return () => { eventEmitter.off("operator.gate", handler); };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ request, resolve }: PermissionGateEvent) => {
      permissionQueue.current.push({ request, resolve });
      if (permissionQueue.current.length === 1) setPendingPermission(request);
      setGatePending(true);
    };
    eventEmitter.on("permission.gate", handler);
    return () => { eventEmitter.off("permission.gate", handler); };
  }, [eventEmitter, setGatePending]);

  const resolvePlanHead = (approved: boolean) => {
    const head = planQueue.current.shift();
    const next = planQueue.current[0] ?? null;
    setPendingPlan(next ? next.plan : null);
    setGatePending(false);
    head?.resolve(approved);
  };

  const resetGates = () => {
    for (const entry of planQueue.current) entry.resolve(false);
    planQueue.current = [];
    for (const entry of operatorQueue.current) entry.resolve({ kind: "cancel" });
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
      const head = permissionQueue.current.shift();
      const next = permissionQueue.current[0] ?? null;
      setPendingPermission(next ? next.request : null);
      setGatePending(false);
      head?.resolve(outcome);
    },
    resetGates,
  };
}
