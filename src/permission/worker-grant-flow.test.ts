import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "@intx/types/runtime";
import { createPermissionGate } from "./gate.js";
import { workerPermissionGate } from "./reactor-authorize.js";
import {
  WORKER_GRANT_TTL_MS,
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

/** Valid assessed ask payload for the grant-flow fixture (Blocker 1). */
const assessedAsk = {
  policyVersion: "1",
  classification: "operator_decision_required",
  blockedOutcome: "cannot produce the authenticated verification result",
  unavailableDirectorPath: "the director has no credential authority",
  permittedAlternatives: [
    {
      attempted: "focused local test",
      result: "requires the missing credential",
      comparableConfidence: false,
    },
  ],
  minimumAddition: "allow an authenticated read-only snapshot",
  declineConsequence: "implementation is complete but verification is blocked",
} as const;

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
    expect(store.peek(requestId)?.status).toBe("pending");

    // Authorize is not execution: a second authorize of the same call still
    // allows without spending the envelope. Exactly-once is enforced when the
    // call executes (see the two-stage KEEPER below).
    const retryAgain = await workerGate.authorizeCall(shellCall("c3", COMMAND));
    expect(retryAgain).toEqual({ effect: "allow" });
    expect(store.peek(requestId)?.status).toBe("pending");
  });

  test("reactor retry of the same exact call reuses the pending envelope", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-dedupe-"));
    const parentGate = makeParentGate(cwd, true);
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-dedupe",
      store,
    });

    const first = await workerGate.authorizeCall(shellCall("c1", COMMAND));
    if (first.effect !== "deny") throw new Error("expected worker deny");
    // Reactor retries mint fresh call ids for the same tool + args: the
    // deny must name the same grant request, not prompt the parent twice.
    const second = await workerGate.authorizeCall(shellCall("c2", COMMAND));
    if (second.effect !== "deny") throw new Error("expected worker deny");
    expect(extractRequestId(second.reason)).toBe(
      extractRequestId(first.reason),
    );
  });

  test("tampered args fall through to a fresh deny; original stays pending", async () => {
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
    expect(store.peek(requestId)?.status).toBe("pending");
  });

  test("headless parent cannot grant: retry denies, envelope stays pending", async () => {
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

    // No operator, no approval, no decline verb: the retry keeps denying
    // against the same pending envelope — nothing is spent, nothing is
    // granted, and the deny still names the original grant request.
    const retry = await workerGate.authorizeCall(shellCall("c2", COMMAND));
    expect(retry.effect).toBe("deny");
    if (retry.effect !== "deny") throw new Error("expected headless deny");
    expect(extractRequestId(retry.reason)).toBe(requestId);
    expect(store.peek(requestId)?.status).toBe("pending");
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
        assessment: assessedAsk,
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

  test("concurrent identical executions allow exactly once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-race-"));
    const parentGate = makeParentGate(cwd, true);
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-race",
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
    expect(store.peek(requestId)?.status).toBe("pending");

    // Two in-flight copies of the exact call (fresh call ids, same args):
    // without serialization both pass precheck before either consumes and
    // the envelope allows twice. Exactly-once is enforced at execution.
    const [retryA, retryB] = await Promise.all([
      workerGate.executionVerdict(shellCall("c2", COMMAND)),
      workerGate.executionVerdict(shellCall("c3", COMMAND)),
    ]);
    const effects = [retryA.effect, retryB.effect].sort();
    expect(effects).toEqual(["allow", "deny"]);
    const loser = retryA.effect === "deny" ? retryA : retryB;
    if (loser.effect !== "deny") throw new Error("expected replay deny");
    expect(loser.reason).toContain("already consumed");
    expect(loser.reason).toContain(requestId);
    expect(store.peek(requestId)?.status).toBe("consumed");
  });

  test("post-expiry retry round mints a fresh envelope, then succeeds", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-reissue-"));
    const parentGate = makeParentGate(cwd, true);
    const store = new WorkerGrantStore();
    const workerGate = workerPermissionGate(parentGate, {
      sessionId: "worker-reissue",
      store,
    });

    const denied = await workerGate.authorizeCall(shellCall("c1", COMMAND));
    if (denied.effect !== "deny") throw new Error("expected worker deny");
    const lapsedId = extractRequestId(denied.reason);
    expect(store.sweepExpired(Date.now() + WORKER_GRANT_TTL_MS + 1)).toBe(1);
    expect(store.peek(lapsedId)?.status).toBe("expired");

    // The lapsed window is not a blackhole: the retry falls through to the
    // gate, which denies fresh with a NEW grant id the worker can ask out of.
    const reissue = await workerGate.authorizeCall(shellCall("c2", COMMAND));
    expect(reissue.effect).toBe("deny");
    if (reissue.effect !== "deny") throw new Error("expected re-issue deny");
    const freshId = extractRequestId(reissue.reason);
    expect(freshId).not.toBe(lapsedId);
    expect(store.peek(freshId)?.status).toBe("pending");
    expect(store.peek(lapsedId)?.status).toBe("expired");

    expect(await parentGate.evaluate(shellCall("parent-1", COMMAND))).toEqual({
      allowed: true,
    });
    expect(await workerGate.authorizeCall(shellCall("c3", COMMAND))).toEqual({
      effect: "allow",
    });
    expect(store.peek(freshId)?.status).toBe("pending");
  });

  test("KEEPER production two-stage: authorize allows, execution consumes, replay denied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-two-stage-"));
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

    // Stage 1 (reactor authorize hook): the granted retry authorizes but the
    // envelope stays pending — nothing has executed yet.
    const retry = await workerGate.authorizeCall(shellCall("c2", COMMAND));
    expect(retry).toEqual({ effect: "allow" });
    expect(store.peek(requestId)?.status).toBe("pending");

    // Stage 2 (tool-runner middleware executionVerdict on the identical call):
    // allows and consumes the single granted execution.
    const executed = await workerGate.executionVerdict(
      shellCall("c2", COMMAND),
    );
    expect(executed).toEqual({ effect: "allow" });
    expect(store.peek(requestId)?.status).toBe("consumed");

    // Exactly-once: a second execution of the same call fails closed, as does
    // a second authorize.
    const replayExecution = await workerGate.executionVerdict(
      shellCall("c2", COMMAND),
    );
    expect(replayExecution.effect).toBe("deny");
    if (replayExecution.effect !== "deny")
      throw new Error("expected replay deny");
    expect(replayExecution.reason).toContain("already consumed");
    expect(replayExecution.reason).toContain(requestId);
    const replayAuthorize = await workerGate.authorizeCall(
      shellCall("c2", COMMAND),
    );
    expect(replayAuthorize.effect).toBe("deny");
  });

  test("KEEPER second session gets its own envelope: pending and consumed variants", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "worker-grant-sessions-"));
    const store = new WorkerGrantStore();
    const gateA = workerPermissionGate(makeParentGate(cwd, true), {
      sessionId: "worker-A",
      store,
    });
    const gateB = workerPermissionGate(makeParentGate(cwd, true), {
      sessionId: "worker-B",
      store,
    });

    // Pending variant: A's pending envelope must not veto B's own deny+ask.
    const deniedA = await gateA.authorizeCall(shellCall("a1", COMMAND));
    if (deniedA.effect !== "deny") throw new Error("expected A deny");
    const idA = extractRequestId(deniedA.reason);
    const deniedB = await gateB.authorizeCall(shellCall("b1", COMMAND));
    if (deniedB.effect !== "deny") throw new Error("expected B deny");
    const idB = extractRequestId(deniedB.reason);
    expect(idB).not.toBe(idA);
    expect(store.peek(idB)?.workerSessionId).toBe("worker-B");
    expect(store.peek(idB)?.status).toBe("pending");

    // Consumed variant: A completes its grant + two-stage retry; a fresh
    // session's identical call still gets its own envelope, never A's veto.
    const parentA = makeParentGate(cwd, true);
    const gateA2 = workerPermissionGate(parentA, {
      sessionId: "worker-A",
      store,
    });
    expect(await parentA.evaluate(shellCall("parent-A", COMMAND))).toEqual({
      allowed: true,
    });
    expect(await gateA2.authorizeCall(shellCall("a2", COMMAND))).toEqual({
      effect: "allow",
    });
    expect(await gateA2.executionVerdict(shellCall("a2", COMMAND))).toEqual({
      effect: "allow",
    });
    expect(store.peek(idA)?.status).toBe("consumed");
    const gateC = workerPermissionGate(makeParentGate(cwd, true), {
      sessionId: "worker-C",
      store,
    });
    const deniedC = await gateC.authorizeCall(shellCall("c1", COMMAND));
    if (deniedC.effect !== "deny") throw new Error("expected C deny");
    const idC = extractRequestId(deniedC.reason);
    expect(idC).not.toBe(idA);
    expect(store.peek(idC)?.workerSessionId).toBe("worker-C");
  });
});
