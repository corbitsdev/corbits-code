// Resume path for reactor approval suspensions.
//
// When the reactor's authz hook suspends an ask-tier call, agent.send()
// settles with { type: "suspended", correlationId, approvalSnapshot }. The
// parked call has no tool result and no resolve closure — its identity is the
// correlationId, persisted as a PendingOperation by the reactor. This module
// rebuilds the operator-facing request from the approval snapshot, resolves it
// through the gate's requestApproval seam (the same modal surface the
// middleware path uses), and delivers the operator's decision back to the
// reactor as a correlated inbound message. An approved decision grants the
// call's one-shot bypass and the reactor re-dispatches the exact parked call;
// a rejected one answers it with an error result.

import type { Agent, SendResult } from "@intx/agent";
import type {
  ApprovalSnapshot,
  ContextStore,
  InboundMessage,
} from "@intx/types/runtime";
import { type } from "arktype";

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { commandReferencesSensitivePath } from "../plugins/secret-guard-plugin.js";
import { APPROVAL_TIMEOUT_RESULT_TEXT } from "../permission/decline-markers.js";
import { buildRequests } from "../permission/classify.js";
import type { PermissionGate } from "../permission/gate.js";
import type { PermissionRequest } from "../permission/types.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "approval-resume"]);

export const APPROVAL_DROPPED_NOTICE =
  "Approval dropped because the session changed.";

const ApprovalSnapshotShape = type({
  name: "string",
  "arguments?": "Record<string, unknown>",
});

export interface ApprovalResume {
  /**
   * Settle a suspended send: show the approval surface, then deliver the
   * operator's decision to the reactor on the correlationId signal channel.
   * Resolves once the decision is delivered (the resumed run continues
   * asynchronously on the reactor loop). Returns false for non-suspension
   * results so callers can forward them unchanged.
   */
  handle: (result: SendResult) => Promise<boolean>;
}

// Rebuild the operator-facing request from the persisted snapshot. Scopes come
// from buildRequests (the same decomposition the middleware path shows), with
// the secret-path rule re-applied: secret shell never offers a persistent
// scope, because future secret-path shell always re-asks.
export function requestFromApprovalSnapshot(
  snapshot: ApprovalSnapshot,
  correlationId: string,
): PermissionRequest | null {
  const parsed = ApprovalSnapshotShape(snapshot);
  if (parsed instanceof type.errors) return null;
  const call = {
    id: correlationId,
    name: parsed.name,
    arguments: parsed.arguments ?? {},
  };
  const [request] = buildRequests(call);
  if (request === undefined) return null;
  const anySecret =
    request.tool === "run_shell" &&
    commandReferencesSensitivePath(request.subject) !== undefined;
  return anySecret ? { ...request, scopes: [] } : request;
}

export async function resolveParkedCallIdFromStore(
  storage: Pick<ContextStore, "load">,
  correlationId: string,
): Promise<string | undefined> {
  const { pendingOperations } = await storage.load();
  const matches = pendingOperations.filter(
    (operation) =>
      operation.kind === "approval" &&
      operation.correlationId === correlationId,
  );
  return matches.length === 1 ? matches[0]?.suspendedCall?.id : undefined;
}

function timeoutResult(
  turns: Awaited<ReturnType<Agent["history"]>>,
  parkedCallId: string,
): boolean {
  return turns.some((turn) =>
    turn.content.some(
      (block) =>
        block.type === "tool_result" &&
        block.callId === parkedCallId &&
        block.content.some(
          (part) =>
            part.type === "text" && part.text === APPROVAL_TIMEOUT_RESULT_TEXT,
        ),
    ),
  );
}

function decisionMessage(
  correlationId: string,
  outcome: "approved" | "rejected",
  message?: string,
): InboundMessage {
  const body: { outcome: "approved" | "rejected"; message?: string } = {
    outcome,
  };
  if (message !== undefined && message.length > 0) body.message = message;
  return {
    ref: { uid: 0, mailbox: "approval" },
    headers: {
      from: "approval@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `approval-${correlationId}`,
      interchangeCorrelationId: correlationId,
      interchangeType:
        outcome === "approved" ? "approval.granted" : "approval.denied",
    },
    flags: [],
    content: JSON.stringify(body),
    signatureStatus: "missing",
  } satisfies InboundMessage;
}

export function createApprovalResume(args: {
  getAgent: () => Pick<Agent, "deliver" | "history"> | undefined;
  deliver?: (
    message: InboundMessage,
    stillCurrent: () => boolean,
  ) => void | Promise<void>;
  captureGeneration?: () => () => boolean;
  onDropped?: (text: string) => void;
  registerParkedCancel?: (cancel: (() => void) | undefined) => void;
  resolveParkedCallId: (
    correlationId: string,
  ) => string | undefined | Promise<string | undefined>;
  gate: PermissionGate;
}): ApprovalResume {
  return {
    handle: async (result) => {
      if (result.type !== "suspended") return false;
      const generationCurrent = args.captureGeneration?.() ?? (() => true);
      const parkedAgent = args.getAgent();
      if (parkedAgent === undefined)
        throw new Error("approval resume: no live agent");
      const { correlationId, approvalSnapshot } = result;
      let cancelled = false;
      let canReject = false;
      const stillCurrent = (): boolean => !cancelled && generationCurrent();
      const cancelParked = (): void => {
        if (cancelled) return;
        cancelled = true;
        if (canReject) {
          parkedAgent.deliver(
            decisionMessage(correlationId, "rejected", APPROVAL_DROPPED_NOTICE),
          );
        }
      };
      const dropParked = (): void => {
        args.onDropped?.(APPROVAL_DROPPED_NOTICE);
        cancelParked();
      };
      args.registerParkedCancel?.(cancelParked);
      try {
        // The resolver captures the paired store synchronously before its first await.
        const parkedCallId = await args.resolveParkedCallId(correlationId);
        if (!stillCurrent()) {
          dropParked();
          return true;
        }
        if (parkedCallId === undefined) return true;
        const initialHistory = await parkedAgent.history();
        if (!stillCurrent()) {
          dropParked();
          return true;
        }
        if (timeoutResult(initialHistory, parkedCallId)) return true;
        canReject = true;

        const deliverDecision = async (
          message: InboundMessage,
        ): Promise<void> => {
          if (!stillCurrent()) return;
          if (args.deliver !== undefined) {
            await args.deliver(message, stillCurrent);
          } else {
            parkedAgent.deliver(message);
          }
        };
        const request =
          approvalSnapshot === undefined
            ? null
            : requestFromApprovalSnapshot(approvalSnapshot, correlationId);
        if (request === null) {
          args.registerParkedCancel?.(undefined);
          await deliverDecision(
            decisionMessage(
              correlationId,
              "rejected",
              "approval surface unavailable",
            ),
          );
          return true;
        }
        const outcome = await args.gate.resolveSuspended(request, stillCurrent);
        if (!stillCurrent()) {
          dropParked();
          return true;
        }
        args.registerParkedCancel?.(undefined);
        const history = await parkedAgent.history();
        const timedOut = timeoutResult(history, parkedCallId);
        if (timedOut) canReject = false;
        if (!stillCurrent()) {
          dropParked();
          return true;
        }
        if (timedOut) {
          logger.warn`late approval decision dropped correlation=${correlationId} timeoutCall=${parkedCallId} outcome=${outcome?.allow === true ? "approved" : "rejected"}`;
          return true;
        }
        await deliverDecision(
          decisionMessage(
            correlationId,
            outcome?.allow === true ? "approved" : "rejected",
            outcome?.allow === true ? undefined : outcome?.message,
          ),
        );
        return true;
      } finally {
        args.registerParkedCancel?.(undefined);
      }
    },
  };
}
