import { useEffect, useRef, useState } from "react";
import type { EventEmitter } from "node:events";
import type { ApprovalOutcome, PermissionRequest } from "../../permission/types.js";
import type { OperatorResult } from "../../agent/tools.js";

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
  pendingOperator: PendingOperator | null;
  pendingPermission: PermissionRequest | null;
  gateOpen: boolean;
  selectOperator: (result: OperatorResult) => void;
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
type OperatorQueueEntry = { question: string; options: string[]; resolve: (result: OperatorResult) => void };
type PermissionQueueEntry = { request: PermissionRequest; resolve: (outcome: ApprovalOutcome) => void };

export function useGates({ eventEmitter, setGatePending }: UseGatesArgs): GateController {
  const [pendingOperator, setPendingOperator] = useState<PendingOperator | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  // FIFO queues — one per gate type. The head entry is what's currently shown.
  const operatorQueue = useRef<OperatorQueueEntry[]>([]);
  const permissionQueue = useRef<PermissionQueueEntry[]>([]);

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

  const resetGates = () => {
    for (const entry of operatorQueue.current) entry.resolve({ kind: "cancel" });
    operatorQueue.current = [];
    for (const entry of permissionQueue.current) entry.resolve({ allow: false });
    permissionQueue.current = [];
    setPendingOperator(null);
    setPendingPermission(null);
    setGatePending(false);
  };

  return {
    pendingOperator,
    pendingPermission,
    gateOpen: pendingOperator !== null || pendingPermission !== null,
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
