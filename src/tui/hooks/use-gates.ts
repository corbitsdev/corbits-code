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
  // Exact shell commands the ask pre-authorizes on approval. Shown verbatim in
  // the operator modal so a yes never covers a command the operator did not read.
  commands?: string[];
  resolve: (result: OperatorResult) => void;
};

export type PermissionGateEvent = {
  request: PermissionRequest;
  resolve: (outcome: ApprovalOutcome) => void;
};

export type PendingOperator = { question: string; options: string[]; commands: string[] };

export type GateController = {
  pendingPlan: PlanStep[] | null;
  pendingOperator: PendingOperator | null;
  pendingPermission: PermissionRequest | null;
  /** Permission gates still queued, including the visible modal. */
  permissionQueueDepth: number;
  /** Queued requests identical to the visible modal's (same tool and subject), head included. */
  permissionBatchSize: number;
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
type OperatorQueueEntry = {
  question: string;
  options: string[];
  commands: string[];
  resolve: (result: OperatorResult) => void;
};
type PermissionQueueEntry = { request: PermissionRequest; resolve: (outcome: ApprovalOutcome) => void };

const isSameRequest = (a: PermissionQueueEntry, b: PermissionQueueEntry): boolean =>
  a.request.tool === b.request.tool && a.request.subject === b.request.subject;

// How many queued entries (head included) one decision on the head resolves.
const batchSizeOf = (queue: readonly PermissionQueueEntry[]): number => {
  const head = queue[0];
  if (head === undefined) return 0;
  return queue.filter((entry) => isSameRequest(entry, head)).length;
};

export function useGates({ eventEmitter, setGatePending }: UseGatesArgs): GateController {
  const [pendingPlan, setPendingPlan] = useState<PlanStep[] | null>(null);
  const [pendingOperator, setPendingOperator] = useState<PendingOperator | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [permissionQueueDepth, setPermissionQueueDepth] = useState(0);
  const [permissionBatchSize, setPermissionBatchSize] = useState(0);

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
    const handler = ({ question, options, commands, resolve }: OperatorGateEvent) => {
      const entry = { question, options, commands: commands ?? [], resolve };
      operatorQueue.current.push(entry);
      if (operatorQueue.current.length === 1) {
        setPendingOperator({ question: entry.question, options: entry.options, commands: entry.commands });
      }
      setGatePending(true);
    };
    eventEmitter.on("operator.gate", handler);
    return () => { eventEmitter.off("operator.gate", handler); };
  }, [eventEmitter, setGatePending]);

  useEffect(() => {
    const handler = ({ request, resolve }: PermissionGateEvent) => {
      permissionQueue.current.push({ request, resolve });
      if (permissionQueue.current.length === 1) setPendingPermission(request);
      setPermissionQueueDepth(permissionQueue.current.length);
      setPermissionBatchSize(batchSizeOf(permissionQueue.current));
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
    const pendingCount =
      planQueue.current.length +
      operatorQueue.current.length +
      permissionQueue.current.length;
    for (const entry of planQueue.current) entry.resolve(false);
    planQueue.current = [];
    for (const entry of operatorQueue.current) entry.resolve({ kind: "cancel" });
    operatorQueue.current = [];
    for (const entry of permissionQueue.current) entry.resolve({ allow: false });
    permissionQueue.current = [];
    setPendingPlan(null);
    setPendingOperator(null);
    setPendingPermission(null);
    setPermissionQueueDepth(0);
    setPermissionBatchSize(0);
    for (let i = 0; i < pendingCount; i += 1) {
      setGatePending(false);
    }
  };

  return {
    pendingPlan,
    pendingOperator,
    pendingPermission,
    permissionQueueDepth,
    permissionBatchSize,
    gateOpen: pendingPlan !== null || pendingOperator !== null || pendingPermission !== null,
    approve: () => resolvePlanHead(true),
    reject: () => resolvePlanHead(false),
    selectOperator: (result: OperatorResult) => {
      const head = operatorQueue.current.shift();
      const next = operatorQueue.current[0] ?? null;
      setPendingOperator(
        next ? { question: next.question, options: next.options, commands: next.commands } : null,
      );
      setGatePending(false);
      head?.resolve(result);
    },
    resolvePermission: (outcome: ApprovalOutcome) => {
      const head = permissionQueue.current.shift();
      if (head === undefined) return;
      // One decision also covers queued duplicates of the request the modal
      // showed — same tool, same subject — and nothing else. Requests for other
      // tools or other subjects, including ones that arrived while the modal
      // was open, stay queued for their own prompt. Only the head carries a
      // persistent grant: duplicates are the same pattern, so one write is the
      // whole grant; they resolve allow/reject once.
      const duplicates = permissionQueue.current.filter((entry) => isSameRequest(entry, head));
      permissionQueue.current = permissionQueue.current.filter((entry) => !isSameRequest(entry, head));
      const next = permissionQueue.current[0] ?? null;
      setPendingPermission(next ? next.request : null);
      setPermissionQueueDepth(permissionQueue.current.length);
      setPermissionBatchSize(batchSizeOf(permissionQueue.current));
      for (let i = 0; i < duplicates.length + 1; i += 1) {
        setGatePending(false);
      }
      head.resolve(outcome);
      const onceOutcome: ApprovalOutcome = {
        allow: outcome.allow,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      };
      for (const entry of duplicates) {
        entry.resolve(onceOutcome);
      }
    },
    resetGates,
  };
}