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
  // Exact shell commands the ask pre-authorizes on approval. Shown verbatim in
  // the operator modal so a yes never covers a command the operator did not read.
  commands?: string[];
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

export type PendingOperator = { question: string; options: string[]; commands: string[] };

export type GateController = {
  pendingPlan: PlanStep[] | null;
  pendingOperator: PendingOperator | null;
  pendingPermission: PermissionRequest | null;
  /** Permission gates still queued, including the visible modal. */
  permissionQueueDepth: number;
  /** Queued requests identical to the visible modal's (same tool, subject, and arguments), head included. */
  permissionBatchSize: number;
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
type OperatorQueueEntry = {
  question: string;
  options: string[];
  commands: string[];
  resolve: (result: OperatorResult) => void;
};
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

// Key-order-insensitive canonical form so two argument payloads compare by
// value. Batch identity must cover the full payload: subjects omit
// consequential arguments (MCP tools key on the tool name, file writes on the
// path), so tool + subject alone would collapse materially different calls.
const stableStringify = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
};

const isSameRequest = (a: PermissionQueueEntry, b: PermissionQueueEntry): boolean =>
  a.request.tool === b.request.tool &&
  a.request.subject === b.request.subject &&
  stableStringify(a.request.arguments) === stableStringify(b.request.arguments);

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
    setPermissionBatchSize(batchSizeOf(permissionQueue.current));
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
    const handler = ({ question, options, commands, resolve }: OperatorGateEvent) => {
      const entry = { question, options, commands: commands ?? [], resolve };
      operatorQueue.current.push(entry);
      if (operatorQueue.current.length === 1) {
        setPendingOperator({ question: entry.question, options: entry.options, commands: entry.commands });
      }
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
      setPermissionBatchSize(batchSizeOf(permissionQueue.current));
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
      setPermissionBatchSize(0);
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
    setPermissionBatchSize(0);
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
    permissionBatchSize,
    permissionTimeoutMs,
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
      const head = permissionQueue.current[0];
      if (head === undefined || head.settled) return;
      // One decision also covers queued duplicates of the request the modal
      // showed — same tool, subject, and arguments — and nothing else. Requests for other
      // tools or other subjects, including ones that arrived while the modal
      // was open, stay queued for their own prompt. Only the head carries a
      // persistent grant: duplicates are the same pattern, so one write is the
      // whole grant; they resolve allow/reject once. A head that timed out was
      // already denied and removed, so it never reaches this batch path.
      const duplicates = permissionQueue.current.slice(1).filter((entry) => isSameRequest(entry, head));
      permissionQueue.current = permissionQueue.current.filter(
        (entry) => entry !== head && !isSameRequest(entry, head),
      );
      const next = permissionQueue.current[0] ?? null;
      setPendingPermission(next ? next.request : null);
      setPermissionTimeoutMs(next?.timeoutMs ?? null);
      if (next !== null) armHeadTimeout(next);
      setPermissionQueueDepth(permissionQueue.current.length);
      setPermissionBatchSize(batchSizeOf(permissionQueue.current));
      for (let i = 0; i < duplicates.length + 1; i += 1) {
        setGatePending(false);
      }
      settlePermission(head, outcome);
      const onceOutcome: ApprovalOutcome = {
        allow: outcome.allow,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
      };
      for (const entry of duplicates) {
        settlePermission(entry, onceOutcome);
      }
    },
    resetGates,
  };
}
