import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@intx/types/runtime";
import { createPermissionGate } from "./gate.js";
import { workerPermissionGate } from "./reactor-authorize.js";
import {
  WorkerGrantStore,
  createDeniedCallEnvelope,
  getProcessWorkerGrantStore,
} from "./worker-grant.js";
import { createSubAgentSessionStore } from "../subagent/session-store.js";

const COMMAND = "npm test";
const shellCall = (id: string, command: string): ToolCall => ({
  id,
  name: "run_shell",
  arguments: { command },
});

function makeParentGate(cwd: string, approve: boolean) {
  return createPermissionGate({
    approvals: [],
    cwd,
    skipPermissions: false,
    interactive: true,
    reactorGated: false,
    // Operator surface: approve the offered exact scope as a session grant.
    requestApproval: async (request) => {
      if (!approve) return { allow: false };
      const exact = request.scopes[0];
      if (exact === undefined) return { allow: true };
      return { allow: true, persist: { ...exact, grant: "session" as const } };
    },
  });
}

function extractRequestId(reason: string): string {
  const match = /grant request ([0-9a-f-]{36})/.exec(reason);
  if (match?.[1] === undefined) {
    throw new Error(`deny reason carries no grant request id: ${reason}`);
  }
  return match[1];
}

describe("worker grant-request flow: deny → parent replay grant → one retry", () => {
  test("retained deny → grant → exactly one success, replay fails closed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-flow-"));
    const parentGate = makeParentGate(cwd, true);
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-1",
      store,
    });

    const denied = await workerGate.authorizeCall(shellCall("c1", COMMAND));
    expect(denied.effect).toBe("deny");
    if (denied.effect !== "deny") throw new Error("expected worker deny");
    expect(denied.reason).toContain("deny");
    expect(denied.reason).toContain(
      "workers cannot complete operator approval",
    );
    const requestId = extractRequestId(denied.reason);
    expect(store.peek(requestId)?.status).toBe("pending");

    const replay = await parentGate.evaluate(shellCall("parent-1", COMMAND));
    expect(replay.allowed).toBe(true);
    expect(parentGate.getSessionApprovals().length).toBeGreaterThan(0);

    const retry = await workerGate.authorizeCall(shellCall("c2", COMMAND));
    expect(retry).toEqual({ effect: "allow" });
    expect(store.peek(requestId)?.status).toBe("consumed");

    const replayAgain = await workerGate.authorizeCall(
      shellCall("c3", COMMAND),
    );
    expect(replayAgain.effect).toBe("deny");
    if (replayAgain.effect !== "deny") throw new Error("expected replay deny");
    expect(replayAgain.reason).toContain("already consumed");
    expect(replayAgain.reason).toContain(requestId);
  });

  test("tampered args fall through to a fresh deny; original stays consumed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-tamper-"));
    const parentGate = makeParentGate(cwd, true);
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-1",
      store,
    });

    const denied = await workerGate.authorizeCall(shellCall("c1", COMMAND));
    if (denied.effect !== "deny") throw new Error("expected worker deny");
    const requestId = extractRequestId(denied.reason);
    expect(await parentGate.evaluate(shellCall("parent-1", COMMAND))).toEqual({
      allowed: true,
    });
    expect(await workerGate.authorizeCall(shellCall("c2", COMMAND))).toEqual({
      effect: "allow",
    });

    const tampered = await workerGate.authorizeCall(
      shellCall("c3", "npm run evil"),
    );
    expect(tampered.effect).toBe("deny");
    if (tampered.effect !== "deny") throw new Error("expected tamper deny");
    expect(tampered.reason).not.toContain("already consumed");
    expect(store.peek(requestId)?.status).toBe("consumed");
  });

  test("headless parent cannot grant: replay denies, auto-decline fails closed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-headless-"));
    // Interactive worker gate so the deny registers an envelope; the PARENT
    // gate is headless (no operator seam).
    const denyGate = createPermissionGate({
      approvals: [],
      cwd,
      skipPermissions: false,
      interactive: true,
      reactorGated: false,
      // Seam wired (so decide preserves ask) but never consulted on the
      // authorizeCall path — the worker deny registers its envelope here.
      requestApproval: async () => ({ allow: false }),
    });
    const headlessGate = createPermissionGate({
      approvals: [],
      cwd,
      skipPermissions: false,
      interactive: false,
      reactorGated: false,
    });
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(denyGate, {
      sessionId: "worker-headless",
      store,
    });

    const denied = await workerGate.authorizeCall(shellCall("c1", COMMAND));
    if (denied.effect !== "deny") throw new Error("expected worker deny");
    const requestId = extractRequestId(denied.reason);

    const replay = await headlessGate.evaluate(shellCall("parent-1", COMMAND));
    expect(replay.allowed).toBe(false);

    expect(
      store.declineAllForSession(
        "worker-headless",
        "headless parent: no operator to approve",
      ),
    ).toBe(1);
    expect(store.peek(requestId)?.status).toBe("declined");
    const retry = await workerGate.authorizeCall(shellCall("c2", COMMAND));
    expect(retry.effect).toBe("deny");
    if (retry.effect !== "deny") throw new Error("expected declined deny");
    expect(retry.reason).toContain("declined");
  });

  test("send_input text answers the ask but grants nothing", () => {
    const sessions = createSubAgentSessionStore();
    const session = sessions.start({
      id: "fleet-1",
      description: "d",
      agentId: "a",
      brief: "b",
    });
    sessions.markRunning(session.id);
    const store = getProcessWorkerGrantStore();
    const envelope = store.register(
      createDeniedCallEnvelope({
        callId: "fleet-c1",
        tool: "run_shell",
        action: "Run",
        subject: COMMAND,
        args: { command: COMMAND },
        cwd: process.cwd(),
        workerSessionId: session.id,
      }),
    );
    let resolved: string | undefined;
    expect(
      sessions.registerAsk(session.id, {
        question: `blocked; quote request ${envelope.requestId}`,
        questionId: "ask-1",
        resolve: (answer) => {
          resolved = answer;
        },
        reject: () => {
          throw new Error("should not reject");
        },
      }),
    ).toBe(true);
    expect(sessions.peekAsk(session.id)?.deniedCall?.requestId).toBe(
      envelope.requestId,
    );

    const echo = JSON.stringify({
      requestId: envelope.requestId,
      granted: true,
    });
    expect(sessions.sendInputOne(session.id, echo)).toEqual({
      ok: true,
      status: "running",
    });
    expect(resolved).toBe(echo);
    expect(store.peek(envelope.requestId)?.status).toBe("pending");
    store.expireSession(session.id, "test teardown");
  });
});
