import type { ToolCall } from "@intx/types/runtime";
import { type } from "arktype";

import type { PermissionRequest } from "./types.js";
import { getProcessWorkerGrantStore } from "./worker-grant.js";

const ApproveWorkerCallRequestId = type({ request_id: "string" });

// The operator approves the worker's frozen call through this prompt, and the
// frozen call does not prompt again for an ordinary ask, so the prompt shows
// that call rather than approve_worker_call's correlation ids. It offers no
// scopes: a standing grant would let the parent model approve worker calls
// with no operator involved.
export function approveWorkerCallRequest(call: ToolCall): PermissionRequest {
  const parsed = ApproveWorkerCallRequestId(call.arguments);
  const requestId =
    parsed instanceof type.errors ? "" : parsed.request_id.trim();
  const envelope =
    requestId.length > 0
      ? getProcessWorkerGrantStore().peek(requestId)
      : undefined;
  if (envelope === undefined) {
    return {
      tool: call.name,
      action: "Approve worker call",
      subject: requestId,
      arguments: call.arguments,
      scopes: [],
      notice:
        "No live denied worker call matches this request, so approving runs nothing.",
    };
  }
  return {
    tool: call.name,
    action: `Approve worker call: ${envelope.toolAction ?? envelope.canonicalTool}`,
    subject: envelope.permissionSubject,
    arguments: call.arguments,
    scopes: [],
    agentLabel: envelope.workerLabel ?? envelope.workerSessionId,
    notice: "Approving lets the worker retry this exact call once.",
  };
}
