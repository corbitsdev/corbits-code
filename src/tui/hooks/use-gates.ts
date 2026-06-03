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
};

export type UseGatesArgs = {
  eventEmitter: EventEmitter;
  setGatePending: (pending: boolean) => void;
};

export function useGates({ eventEmitter, setGatePending }: UseGatesArgs): GateController {
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const [pendingOperator, setPendingOperator] = useState<PendingOperator | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const planResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const operatorResolveRef = useRef<((index: number) => void) | null>(null);
  const permissionResolveRef = useRef<((outcome: ApprovalOutcome) => void) | null>(null);

  useEffect(() => {
    const handler = ({ plan, resolve }: PlanGateEvent) => {
      planResolveRef.current = resolve;
      setPendingPlan(plan);
      setGatePending(true);
    };
    eventEmitter.on("plan.gate", handler);
    return () => {
      eventEmitter.off("plan.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ question, options, resolve }: OperatorGateEvent) => {
      operatorResolveRef.current = resolve;
      setPendingOperator({ question, options });
      setGatePending(true);
    };
    eventEmitter.on("operator.gate", handler);
    return () => {
      eventEmitter.off("operator.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ request, resolve }: PermissionGateEvent) => {
      permissionResolveRef.current = resolve;
      setPendingPermission(request);
      setGatePending(true);
    };
    eventEmitter.on("permission.gate", handler);
    return () => {
      eventEmitter.off("permission.gate", handler);
    };
  }, [eventEmitter, setGatePending]);

  const resolvePlan = (approved: boolean) => {
    const resolve = planResolveRef.current;
    planResolveRef.current = null;
    setPendingPlan(null);
    setGatePending(false);
    resolve?.(approved);
  };

  return {
    pendingPlan,
    pendingOperator,
    pendingPermission,
    gateOpen: pendingPlan !== null || pendingOperator !== null || pendingPermission !== null,
    approve: () => resolvePlan(true),
    reject: () => resolvePlan(false),
    selectOperator: (index: number) => {
      const resolve = operatorResolveRef.current;
      operatorResolveRef.current = null;
      setPendingOperator(null);
      setGatePending(false);
      resolve?.(index);
    },
    resolvePermission: (outcome: ApprovalOutcome) => {
      const resolve = permissionResolveRef.current;
      permissionResolveRef.current = null;
      setPendingPermission(null);
      setGatePending(false);
      resolve?.(outcome);
    },
  };
}
