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
import type { ApprovalSnapshot, InboundMessage } from "@intx/types/runtime";
import { type } from "arktype";

import { commandReferencesSensitivePath } from "../plugins/secret-guard-plugin.js";
import { buildRequests } from "../permission/classify.js";
import type { PermissionGate } from "../permission/gate.js";
import type { PermissionRequest } from "../permission/types.js";

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
    request.tool === "run_shell" && commandReferencesSensitivePath(request.subject) !== undefined;
  return anySecret ? { ...request, scopes: [] } : request;
}

function decisionMessage(
  correlationId: string,
  outcome: "approved" | "rejected",
  message?: string,
) {
  const body: { outcome: "approved" | "rejected"; message?: string } = { outcome };
  if (message !== undefined && message.length > 0) body.message = message;
  return {
    ref: { uid: 0, mailbox: "approval" },
    headers: {
      from: "approval@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `approval-${correlationId}`,
      interchangeCorrelationId: correlationId,
    },
    flags: [],
    content: JSON.stringify(body),
    signatureStatus: "missing",
  } satisfies InboundMessage;
}

export function createApprovalResume(args: {
  // Late-bound: the live agent is read at handle() time so rebuilds
  // (/clear, model switch) deliver through the current instance.
  getAgent: () => Pick<Agent, "deliver"> | undefined;
  gate: PermissionGate;
}): ApprovalResume {
  const { getAgent, gate } = args;
  return {
    handle: async (result) => {
      if (result.type !== "suspended") return false;
      const agent = getAgent();
      if (agent === undefined) return true;
      const { correlationId, approvalSnapshot } = result;

      if (approvalSnapshot === undefined) {
        // A suspension without a snapshot cannot be surfaced; fail closed by
        // rejecting the parked call so the run does not hang on an invisible
        // gate.
        agent.deliver(decisionMessage(correlationId, "rejected", "approval surface unavailable"));
        return true;
      }

      const request = requestFromApprovalSnapshot(approvalSnapshot, correlationId);
      if (request === null) {
        agent.deliver(decisionMessage(correlationId, "rejected", "approval surface unavailable"));
        return true;
      }

      const outcome = await gate.resolveSuspended(request);
      if (outcome === undefined || !outcome.allow) {
        agent.deliver(decisionMessage(correlationId, "rejected", outcome?.message));
        return true;
      }
      agent.deliver(decisionMessage(correlationId, "approved"));
      return true;
    },
  };
}
