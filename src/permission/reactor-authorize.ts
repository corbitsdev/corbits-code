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
  createDeniedCallEnvelope,
  fingerprintDeniedCall,
  formatWorkerDenyWithGrantId,
  getProcessWorkerGrantStore,
  type WorkerGrantStore,
} from "./worker-grant.js";
import { canonicalToolName } from "../agent/canonical-tool-name.js";
import { getSubAgentIdentity } from "../subagent/identity-context.js";
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

function isWorkerControlPlaneTool(name: string): boolean {
  return WORKER_CONTROL_PLANE_TOOLS.has(canonicalToolName(name));
}

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

export interface WorkerGrantOptions {
  /** Defaults to the process-shared sidecar (worker deny side registers,
   * parent observes/consumes). Tests pass an isolated store. */
  store?: WorkerGrantStore;
  /** Owning worker session; absent means no envelope is minted or matched. */
  sessionId?: string | (() => string | undefined);
  workspaceRoot?: string;
}

function resolveWorkerSessionId(
  sessionId: WorkerGrantOptions["sessionId"],
): string | undefined {
  return typeof sessionId === "function" ? sessionId() : sessionId;
}

function resolveWorkerCwd(cwd: string | undefined): string {
  return cwd ?? getSubAgentIdentity()?.cwd ?? process.cwd();
}

function workerCallIdentity(
  sessionId: string,
  call: ToolCallType,
  cwd: string,
): {
  sessionId: string;
  canonicalTool: string;
  args: Record<string, unknown>;
  cwd: string;
} {
  return {
    sessionId,
    canonicalTool: canonicalToolName(call.name),
    args: (call.arguments ?? {}) as Record<string, unknown>,
    cwd,
  };
}

/**
 * Denied-call sidecar: on a worker deny-on-ask, register the exact denied
 * call and name only its requestId in the deny reason. Reuses a still-pending
 * envelope for the same exact call instead of minting duplicates across
 * reactor retries with fresh call ids.
 */
function denyWorkerCallWithEnvelope(
  options: WorkerGrantOptions | undefined,
  call: ToolCallType,
  request: PermissionRequest,
  cwd: string,
  baseReason: string,
): { effect: "deny"; reason: string } {
  const sessionId =
    options !== undefined
      ? resolveWorkerSessionId(options.sessionId)
      : undefined;
  if (sessionId === undefined) return { effect: "deny", reason: baseReason };
  const store = options?.store ?? getProcessWorkerGrantStore();
  const identity = workerCallIdentity(sessionId, call, cwd);
  const existing = store.pendingMatch(
    identity.sessionId,
    identity.canonicalTool,
    identity.args,
    identity.cwd,
  );
  const envelope =
    existing ??
    store.register(
      createDeniedCallEnvelope({
        callId: call.id,
        tool: call.name,
        action: request.action,
        subject: request.subject,
        args: identity.args,
        cwd: identity.cwd,
        workerSessionId: identity.sessionId,
        ...(options?.workspaceRoot !== undefined
          ? { workspaceRoot: options.workspaceRoot }
          : {}),
      }),
    );
  return {
    effect: "deny",
    reason: formatWorkerDenyWithGrantId(baseReason, envelope.requestId),
  };
}

/** Mutex key covering the envelope match: concurrent identical worker calls
 * serialize through precheck-to-consume so one envelope allows exactly once. */
function workerGrantKey(
  sessionId: string,
  call: ToolCallType,
  cwd: string,
): string {
  const identity = workerCallIdentity(sessionId, call, cwd);
  return `${sessionId}\n${fingerprintDeniedCall(identity.canonicalTool, identity.args, identity.cwd)}`;
}

async function authorizeWorkerCall(
  gate: PermissionGate,
  call: ToolCallType,
  grantOptions?: WorkerGrantOptions,
  cwd?: string,
): Promise<{ effect: "allow" } | { effect: "deny"; reason: string }> {
  if (isWorkerControlPlaneTool(call.name)) return { effect: "allow" };
  const workerCwd = resolveWorkerCwd(cwd);
  const sessionId = resolveWorkerSessionId(grantOptions?.sessionId);
  if (sessionId === undefined)
    return authorizeWorkerCallInner(gate, call, grantOptions, workerCwd);
  const store = grantOptions?.store ?? getProcessWorkerGrantStore();
  return store.runExclusive(workerGrantKey(sessionId, call, workerCwd), () =>
    authorizeWorkerCallInner(gate, call, grantOptions, workerCwd, {
      sessionId,
      store,
    }),
  );
}

async function authorizeWorkerCallInner(
  gate: PermissionGate,
  call: ToolCallType,
  grantOptions: WorkerGrantOptions | undefined,
  workerCwd: string,
  grant?: { sessionId: string; store: WorkerGrantStore },
): Promise<{ effect: "allow" } | { effect: "deny"; reason: string }> {
  if (grant !== undefined) {
    const precheck = grant.store.precheck(
      workerCallIdentity(grant.sessionId, call, workerCwd),
    );
    if (!precheck.ok) return { effect: "deny", reason: precheck.blocker };
  }
  const verdict = await gate.authorizeCall(call);
  // Authorize never consumes: it only permits the call to proceed to the
  // tool-runner middleware, which enforces executionVerdict. Consuming here
  // would spend the envelope before execution and deny the granted retry as
  // "already consumed". The single consumption happens in
  // executionVerdictWorkerCallInner, the stage that actually permits
  // execution.
  if (verdict.effect === "allow") return verdict;
  if (verdict.effect !== "ask") return verdict;
  return denyWorkerCallWithEnvelope(
    grantOptions,
    call,
    verdict.request,
    workerCwd,
    workerUnresolvedAskReason(verdict.request),
  );
}

async function evaluateWorkerCall(
  gate: PermissionGate,
  call: ToolCallType,
  grantOptions?: WorkerGrantOptions,
): Promise<GateVerdict> {
  const verdict = await authorizeWorkerCall(gate, call, grantOptions);
  if (verdict.effect === "allow") return { allowed: true };
  return { allowed: false, reason: verdict.reason };
}

async function executionVerdictWorkerCall(
  gate: PermissionGate,
  call: ToolCallType,
  grantOptions?: WorkerGrantOptions,
  cwd?: string,
): Promise<AuthorizeVerdict> {
  if (isWorkerControlPlaneTool(call.name)) return { effect: "allow" };
  const workerCwd = resolveWorkerCwd(cwd);
  const sessionId = resolveWorkerSessionId(grantOptions?.sessionId);
  if (sessionId === undefined)
    return executionVerdictWorkerCallInner(gate, call, grantOptions, workerCwd);
  const store = grantOptions?.store ?? getProcessWorkerGrantStore();
  return store.runExclusive(workerGrantKey(sessionId, call, workerCwd), () =>
    executionVerdictWorkerCallInner(gate, call, grantOptions, workerCwd, {
      sessionId,
      store,
    }),
  );
}

async function executionVerdictWorkerCallInner(
  gate: PermissionGate,
  call: ToolCallType,
  grantOptions: WorkerGrantOptions | undefined,
  workerCwd: string,
  grant?: { sessionId: string; store: WorkerGrantStore },
): Promise<AuthorizeVerdict> {
  if (grant !== undefined) {
    const precheck = grant.store.precheck(
      workerCallIdentity(grant.sessionId, call, workerCwd),
    );
    if (!precheck.ok) return { effect: "deny", reason: precheck.blocker };
  }
  const verdict = await gate.executionVerdict(call);
  // Sole consumption point: the execution backstop spends the envelope when
  // the exact call is allowed, so one grant request permits exactly one
  // execution. Authorize deliberately does not consume (see above).
  if (verdict.effect === "allow") {
    if (grant !== undefined) {
      grant.store.consumeOnAllow(
        workerCallIdentity(grant.sessionId, call, workerCwd),
      );
    }
    return verdict;
  }
  if (verdict.effect !== "ask") return verdict;
  return denyWorkerCallWithEnvelope(
    grantOptions,
    call,
    verdict.request,
    workerCwd,
    workerUnresolvedAskReason(verdict.request),
  );
}

// Shared-policy view for worker posix/MCP plugins and reactor authz: live
// grants stay on the parent, reactor-gated middleware is `isReactorGated()`,
// and authorizeCall never emits ask.
export function workerPermissionGate(
  gate: PermissionGate,
  grantOptions?: WorkerGrantOptions,
): PermissionGate {
  return {
    evaluate: (call) => evaluateWorkerCall(gate, call, grantOptions),
    authorizeCall: (call) => authorizeWorkerCall(gate, call, grantOptions),
    executionVerdict: (call) =>
      executionVerdictWorkerCall(gate, call, grantOptions),
    resolveSuspended: (request) => gate.resolveSuspended(request),
    isReactorGated: () => true,
    getApprovals: () => gate.getApprovals(),
    reset: () => gate.reset(),
    clearDenials: () => gate.clearDenials(),
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
    getTrustedPluginRoots: () => gate.getTrustedPluginRoots(),
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
        // the gate's specific reason is preserved here for the audit trail.
        logger.warn`authz deny resource=${resource} reason=${verdict.reason}`;
        return { effect: "deny", matchingGrants: [], resolvedBy: null };
      case "ask":
        return { effect: "ask", matchingGrants: [], resolvedBy: null };
    }
  };
}

export function createWorkerAuthorize(
  gate: PermissionGate,
  grantOptions?: WorkerGrantOptions,
): (
  resource: string,
  action: string,
  context: unknown,
) => Promise<AuthzCallResult> {
  const workerGate = workerPermissionGate(gate, grantOptions);
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
