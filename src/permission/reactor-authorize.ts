// Bridge from the permission gate onto the reactor's before-tool authz seam.
//
// The vendored authz extension calls authorize(`tool:<name>`, "invoke", ctx)
// where ctx is the frozen ToolCall itself (see
// vendor/intx-inference/PATCHES.md#authz-ts-authorize-call-context). This
// module validates that boundary and maps the gate's decision onto the
// effect vocabulary the hook consumes: allow proceeds, deny blocks (with the
// hook's generic reason text — the gate's specific reasons are policy-internal
// and are preserved in the ask/audit surfaces, not in the model-facing block,
// except worker unresolved-ask denials which pass the subject-named reason),
// and ask suspends the call as a PendingOperation keyed by the correlationId
// the hook mints.

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { ToolCall, type ToolCall as ToolCallType } from "@intx/types/runtime";
import { type } from "arktype";

import type { AuthzCallResult } from "@intx/inference";
import { WORKER_CANNOT_COMPLETE_APPROVAL } from "./decline-markers.js";
import type { AuthorizeVerdict, GateVerdict, PermissionGate } from "./gate.js";
import type { PermissionRequest } from "./types.js";
import {
  FLEET_VERBS,
  ORCHESTRATOR_ONLY_FLEET_VERBS,
} from "../subagent/authority.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "authz"]);

const AuthorizeContext = ToolCall;

// Worker-only control plane: the parent never mounts these (leaf) or cannot
// grant them independently of spawn (nested fleet verbs other than spawn).
// spawn_agent stays grant-gated. search_agents is Tier 1 only.
const WORKER_CONTROL_PLANE_TOOLS = new Set([
  "submit_result",
  "ask_director",
  ...[...FLEET_VERBS].filter(
    (name) =>
      name !== "spawn_agent" && !ORCHESTRATOR_ONLY_FLEET_VERBS.has(name),
  ),
]);

export function workerUnresolvedAskReason(request: PermissionRequest): string {
  return `${request.action} (${request.subject}) requires a parent permission grant; ${WORKER_CANNOT_COMPLETE_APPROVAL}`;
}

function readAuthorizeToolCall(
  resource: string,
  action: string,
  context: unknown,
): ToolCallType {
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
  return call satisfies ToolCallType;
}

async function authorizeWorkerCall(
  gate: PermissionGate,
  call: ToolCallType,
): Promise<{ effect: "allow" } | { effect: "deny"; reason: string }> {
  if (WORKER_CONTROL_PLANE_TOOLS.has(call.name)) return { effect: "allow" };
  const verdict = await gate.authorizeCall(call);
  if (verdict.effect !== "ask") return verdict;
  return { effect: "deny", reason: workerUnresolvedAskReason(verdict.request) };
}

async function evaluateWorkerCall(
  gate: PermissionGate,
  call: ToolCallType,
): Promise<GateVerdict> {
  const verdict = await authorizeWorkerCall(gate, call);
  if (verdict.effect === "allow") return { allowed: true };
  return { allowed: false, reason: verdict.reason };
}

async function executionVerdictWorkerCall(
  gate: PermissionGate,
  call: ToolCallType,
): Promise<AuthorizeVerdict> {
  if (WORKER_CONTROL_PLANE_TOOLS.has(call.name)) return { effect: "allow" };
  const verdict = await gate.executionVerdict(call);
  if (verdict.effect !== "ask") return verdict;
  return { effect: "deny", reason: workerUnresolvedAskReason(verdict.request) };
}

// Shared-policy view for worker posix/MCP plugins and reactor authz: live
// grants stay on the parent, reactor-gated middleware is `isReactorGated()`,
// and authorizeCall never emits ask.
export function workerPermissionGate(gate: PermissionGate): PermissionGate {
  return {
    evaluate: (call) => evaluateWorkerCall(gate, call),
    authorizeCall: (call) => authorizeWorkerCall(gate, call),
    executionVerdict: (call) => executionVerdictWorkerCall(gate, call),
    resolveSuspended: (request) => gate.resolveSuspended(request),
    isReactorGated: () => true,
    getApprovals: () => gate.getApprovals(),
    reset: () => gate.reset(),
    getSessionApprovals: () => gate.getSessionApprovals(),
    removeSessionApproval: (target) => gate.removeSessionApproval(target),
    setSeededApprovals: (seeded) => gate.setSeededApprovals(seeded),
    getAuto: () => gate.getAuto(),
    setAuto: (value) => gate.setAuto(value),
    getSkipPermissions: () => gate.getSkipPermissions(),
    setSkipPermissions: (value) => gate.setSkipPermissions(value),
    setProviderIdentity: (providerName, model) =>
      gate.setProviderIdentity(providerName, model),
    registerMcpClient: (client) => gate.registerMcpClient(client),
    unregisterMcpServer: (serverName) => gate.unregisterMcpServer(serverName),
  };
}

function allowAuthz(): AuthzCallResult {
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
}

export function createReactorAuthorize(
  gate: PermissionGate,
): (
  resource: string,
  action: string,
  context: unknown,
) => Promise<AuthzCallResult> {
  return async (resource, action, context) => {
    const call = readAuthorizeToolCall(resource, action, context);
    const verdict = await gate.authorizeCall(call);
    switch (verdict.effect) {
      case "allow":
        return allowAuthz();
      case "deny":
        // The model-facing block stays generic (upstream's formatBlockReason);
        // the gate's specific reason is preserved here for the audit trail —
        // without this it reaches neither model, transcript, nor any log.
        logger.warn`authz deny resource=${resource} reason=${verdict.reason}`;
        return { effect: "deny", matchingGrants: [], resolvedBy: null };
      case "ask":
        return { effect: "ask", matchingGrants: [], resolvedBy: null };
    }
  };
}

export function createWorkerAuthorize(
  gate: PermissionGate,
): (
  resource: string,
  action: string,
  context: unknown,
) => Promise<AuthzCallResult> {
  const workerGate = workerPermissionGate(gate);
  return async (resource, action, context) => {
    const call = readAuthorizeToolCall(resource, action, context);
    const verdict = await workerGate.authorizeCall(call);
    if (verdict.effect === "allow") return allowAuthz();
    if (verdict.effect === "ask") {
      throw new Error("worker authorizeCall emitted ask");
    }
    logger.warn`authz deny resource=${resource} reason=${verdict.reason}`;
    return {
      effect: "deny",
      matchingGrants: [],
      resolvedBy: null,
      reason: verdict.reason,
    };
  };
}
