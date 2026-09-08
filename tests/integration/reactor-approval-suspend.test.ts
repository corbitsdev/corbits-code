import { describe, expect, test } from "bun:test";

import type { ToolCall } from "@intx/types/runtime";

import { createPermissionGate } from "../../src/permission/gate.js";
import { createReactorAuthorize } from "../../src/permission/reactor-authorize.js";
import {
  createApprovalResume,
  requestFromApprovalSnapshot,
} from "../../src/session/approval-resume.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilSuspended,
  toolDoneEvents,
} from "./harness.js";

const CURL_CALL = { name: "run_shell", args: { command: "curl -sS https://example.com" } };

function gateWithDeferredApproval() {
  const asks: string[] = [];
  let release: ((outcome: { allow: boolean; message?: string }) => void) | undefined;
  return {
    asks,
    gate: createPermissionGate({
      approvals: [],
      interactive: true,
      skipPermissions: false,
      auto: false,
      reactorGated: true,
      requestApproval: (request) => {
        asks.push(`${request.tool}:${request.subject}`);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }),
    approve: () => release?.({ allow: true }),
    reject: (message?: string) => release?.({ allow: false, ...(message ? { message } : {}) }),
  };
}

function openWith(gate: ReturnType<typeof gateWithDeferredApproval>["gate"]) {
  return openIntegrationSession({ permissionGate: gate, authorize: createReactorAuthorize(gate) });
}

// The resume path reads history (async) before raising the approval surface,
// so tests must wait for the ask rather than yielding a single microtask.
async function waitForAsk(ctx: ReturnType<typeof gateWithDeferredApproval>): Promise<void> {
  for (let i = 0; i < 100 && ctx.asks.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("integration — reactor approval suspend/resume", () => {
  test.serial(
    "ask-tier call suspends with a correlationId, resumes on approval, and re-dispatches without re-asking",
    async () => {
      const ctx = gateWithDeferredApproval();
      const session = await openWith(ctx.gate);
      try {
        session.harness.scenario.replyOnce("anthropic", { toolCalls: [CURL_CALL] });
        session.harness.scenario.replyOnce("anthropic", { text: "Fetched." });

        const turn = await runUntilSuspended(session, "Please fetch example.com with curl.");
        const { result } = turn;
        expect(result.type).toBe("suspended");
        if (result.type !== "suspended") return;

        // The parked call carried an approver-facing snapshot and parked on a
        // gate keyed by the correlationId (reactor.gate.blocked).
        expect(result.approvalSnapshot?.name).toBe("run_shell");
        expect(
          turn.events.some(
            (e) =>
              e.type === "reactor.gate.blocked" && e.data.correlationId === result.correlationId,
          ),
        ).toBe(true);
        // No tool ran, and no approval surface was raised yet — raising it is
        // the resume path's job (the send merely parks).
        expect(toolDoneEvents(turn.events)).toHaveLength(0);
        expect(ctx.asks.length).toBe(0);

        // Production resume path: rebuild the request from the persisted
        // snapshot, settle it through the gate's requestApproval seam (which
        // mints grants), deliver the decision on the correlation channel.
        const snapshot = result.approvalSnapshot;
        if (snapshot === undefined) throw new Error("suspension carried no approval snapshot");
        const request = requestFromApprovalSnapshot(snapshot, result.correlationId);
        expect(request?.subject).toBe("curl -sS https://example.com");
        const resume = createApprovalResume({ getAgent: () => session.agent, gate: ctx.gate });
        const handling = resume.handle(result);
        await waitForAsk(ctx);
        expect(ctx.asks.length).toBe(1);
        ctx.approve();
        expect(await handling).toBe(true);

        const reply = await turn.reply();
        // The parked call was re-dispatched and actually executed (approvedOnce
        // bypass, real tool.start) without a second ask, and its result is not
        // a permission denial.
        expect(ctx.asks.length).toBe(1);
        expect(
          turn.events.some((e) => e.type === "tool.start" && e.data.call.name === "run_shell"),
        ).toBe(true);
        const dones = toolDoneEvents(turn.events);
        const firstDone = dones[0];
        if (firstDone === undefined) throw new Error("re-dispatch produced no tool.done");
        const firstResult = firstDone.data.result;
        expect(
          firstResult.isError !== true || !String(firstResult.content).includes("Denied by policy"),
        ).toBe(true);
        expect(reply.length).toBeGreaterThan(0);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial("rejected decision answers the parked call with an error result", async () => {
    const ctx = gateWithDeferredApproval();
    const session = await openWith(ctx.gate);
    try {
      session.harness.scenario.replyOnce("anthropic", { toolCalls: [CURL_CALL] });
      session.harness.scenario.replyOnce("anthropic", { text: "Understood." });

      const turn = await runUntilSuspended(session, "Please fetch example.com.");
      const { result } = turn;
      expect(result.type).toBe("suspended");
      if (result.type !== "suspended") return;

      const resume = createApprovalResume({ getAgent: () => session.agent, gate: ctx.gate });
      const handling = resume.handle(result);
      await waitForAsk(ctx);
      ctx.reject("not today");
      expect(await handling).toBe(true);

      await turn.reply();
      // resume.tool_result answers the parked call by committing the result
      // turn directly (upstream does not emit tool.done for it), so the
      // approver's reason reaches the model through history.
      const history = await session.agent.history();
      const denied = history
        .flatMap((t) => t.content)
        .some(
          (b) =>
            b.type === "tool_result" &&
            b.content.some((c) => c.type === "text" && c.text.includes("denied by approver")),
        );
      expect(denied).toBe(true);
    } finally {
      await closeIntegrationSession(session);
    }
  });

  test.serial(
    "headless runs deny ask-tier calls as a block without any approval surface",
    async () => {
      const gate = createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: false,
        reactorGated: true,
      });
      const session = await openIntegrationSession({
        permissionGate: gate,
        authorize: createReactorAuthorize(gate),
      });
      try {
        session.harness.scenario.replyOnce("anthropic", { toolCalls: [CURL_CALL] });
        session.harness.scenario.replyOnce("anthropic", { text: "Understood." });

        const turn = await runUntilSuspended(session, "Please fetch example.com.");
        await turn.reply();
        const dones = toolDoneEvents(turn.events);
        expect(dones.length).toBeGreaterThanOrEqual(1);
        expect(dones[0]!.data.result.isError).toBe(true);
        expect(dones[0]!.data.result.content).toContain("Denied by policy: tool:run_shell/invoke");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );

  test.serial("chained hard-deny blocks before any approval surface", async () => {
    const ctx = gateWithDeferredApproval();
    const session = await openWith(ctx.gate);
    try {
      session.harness.scenario.replyOnce("anthropic", {
        toolCalls: [{ name: "run_shell", args: { command: "echo ok && sudo rm -rf /etc" } }],
      });
      session.harness.scenario.replyOnce("anthropic", { text: "Understood." });

      const turn = await runUntilSuspended(session, "Run that for me.");
      await turn.reply();
      const dones = toolDoneEvents(turn.events);
      expect(dones.length).toBeGreaterThanOrEqual(1);
      expect(dones[0]!.data.result.isError).toBe(true);
      // Assert the block text: this deny is a policy deny, not an operator
      // decline, so the director's classification must leave it unmatched.
      expect(dones[0]!.data.result.content).toContain("Denied by policy:");
      // Stricter-than-authz command deny is preserved as a block effect; the
      // approval surface was never raised.
      expect(ctx.asks.length).toBe(0);
    } finally {
      await closeIntegrationSession(session);
    }
  });

  test.serial(
    "rejected decision with a reason re-infers on the reason, not the canned decline",
    async () => {
      const ctx = gateWithDeferredApproval();
      const session = await openWith(ctx.gate);
      try {
        session.harness.scenario.replyOnce("anthropic", { toolCalls: [CURL_CALL] });
        session.harness.scenario.replyOnce("anthropic", { text: "I'll skip the fetch, then." });

        const turn = await runUntilSuspended(session, "Please fetch example.com.");
        const { result } = turn;
        expect(result.type).toBe("suspended");
        if (result.type !== "suspended") return;

        const resume = createApprovalResume({ getAgent: () => session.agent, gate: ctx.gate });
        const handling = resume.handle(result);
        await waitForAsk(ctx);
        ctx.reject("never touch the network");
        expect(await handling).toBe(true);

        // The reply must come from re-inference (the scenario's scripted
        // model turn), not the director's canned decline.
        const reply = await turn.reply();
        expect(reply).toBe("I'll skip the fetch, then.");
        expect(reply).not.toBe("Tool call rejected by operator.");
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );
});

// The vendored authz seam must hand the authorize callback the full ToolCall —
// argument-level policy is exactly why this stage adopted the primitive.
describe("authz seam carries the ToolCall context", () => {
  function extWith(policy: (call: ToolCall) => void) {
    return createReactorAuthorize({
      authorizeCall: async (call: ToolCall) => {
        policy(call);
        return { effect: "allow" };
      },
    } as never);
  }

  test("serial call", async () => {
    const seen: ToolCall[] = [];
    const authorize = extWith((call) => seen.push(call));
    await authorize("tool:run_shell", "invoke", {
      id: "c1",
      name: "run_shell",
      arguments: { command: "ls" },
    });
    expect(seen[0]!.arguments).toEqual({ command: "ls" });
  });

  test("parallel batch keeps per-call attribution", async () => {
    const ctxs: ToolCall[] = [];
    const authorize = extWith((call) => ctxs.push(call));
    const calls = [
      { id: "p1", name: "run_shell", arguments: { command: "one" } },
      { id: "p2", name: "run_shell", arguments: { command: "two" } },
    ];
    await Promise.all(calls.map((call) => authorize(`tool:${call.name}`, "invoke", call)));
    expect(ctxs.map((c) => c.arguments.command).sort()).toEqual(["one", "two"]);
  });

  test("non-ToolCall context fails loud", async () => {
    const authorize = extWith(() => {});
    await expect(authorize("tool:run_shell", "invoke", { nope: true })).rejects.toThrow(
      /not a ToolCall/,
    );
  });
});
