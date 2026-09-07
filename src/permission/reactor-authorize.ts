// Bridge from the permission gate onto the reactor's before-tool authz seam.
//
// The vendored authz extension calls authorize(`tool:<name>`, "invoke", ctx)
// where ctx is the frozen ToolCall itself (see
// vendor/intx-inference/PATCHES.md#authz-ts-authorize-call-context). This
// module validates that boundary and maps the gate's decision onto the
// effect vocabulary the hook consumes: allow proceeds, deny blocks (with the
// hook's generic reason text — the gate's specific reasons are policy-internal
// and are preserved in the ask/audit surfaces, not in the model-facing block),
// and ask suspends the call as a PendingOperation keyed by the correlationId
// the hook mints.

import { ToolCall, type ToolCall as ToolCallType } from "@intx/types/runtime";
import { type } from "arktype";

import type { AuthzCallResult } from "@intx/inference";
import type { PermissionGate } from "./gate.js";

const AuthorizeContext = ToolCall;

export function createReactorAuthorize(
  gate: PermissionGate,
): (resource: string, action: string, context: unknown) => Promise<AuthzCallResult> {
  return async (resource, action, context) => {
    const call = AuthorizeContext(context);
    if (call instanceof type.errors) {
      throw new Error(`authz seam context is not a ToolCall: ${call.summary}`);
    }
    if (resource !== `tool:${call.name}`) {
      throw new Error(
        `authz seam resource ${resource} does not match call context tool ${call.name}`,
      );
    }
    if (action !== "invoke") {
      throw new Error(`authz seam saw unexpected action ${action}`);
    }

    const verdict = await gate.authorizeCall(call satisfies ToolCallType);
    switch (verdict.effect) {
      case "allow":
        return { effect: "allow", matchingGrants: [], resolvedBy: null };
      case "deny":
        return { effect: "deny", matchingGrants: [], resolvedBy: null };
      case "ask":
        return { effect: "ask", matchingGrants: [], resolvedBy: null };
    }
  };
}
