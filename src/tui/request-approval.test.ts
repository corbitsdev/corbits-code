import { describe, expect, test } from "bun:test";
import { createGateRequestApproval } from "./request-approval.js";
import {
  getToolApprovalBudget,
  runWithToolExecutionWatchdog,
} from "./tool-execution-watchdog.js";
import type { PermissionGateEvent } from "./hooks/use-gates.js";
import type { ApprovalOutcome, PermissionRequest } from "../permission/types.js";

const request: PermissionRequest = {
  tool: "run_shell",
  action: "Run shell command",
  subject: "bun test",
  scopes: [],
};

const noGoal = () => undefined;

describe("createGateRequestApproval", () => {
  test("denies immediately when no gate listener exists", async () => {
    let outcome: ApprovalOutcome | undefined;
    await runWithToolExecutionWatchdog(
      { id: "1", name: "run_shell", arguments: {} },
      new AbortController().signal,
      50,
      async () => {
        const requestApproval = createGateRequestApproval({
          emitGate: () => false,
          goalTimeout: noGoal,
        });
        outcome = await requestApproval(request);
        const budget = getToolApprovalBudget();
        // finish() must have resumed the budget: with the clock ticking again
        // the 50ms budget expires during this wait.
        await new Promise((r) => setTimeout(r, 100));
        expect(budget?.signal.aborted).toBe(true);
        return { callId: "1", content: "done" };
      },
      { salvageGraceMs: 80, waitForApproval: true },
    );
    expect(outcome).toMatchObject({ allow: false });
    expect(outcome?.message).toContain("denied");
  });

  test("pauses the budget while the prompt is open and resumes on resolve", async () => {
    let captured: PermissionGateEvent | undefined;
    const result = await runWithToolExecutionWatchdog(
      { id: "2", name: "run_shell", arguments: {} },
      new AbortController().signal,
      60,
      async () => {
        const requestApproval = createGateRequestApproval({
          emitGate: (event) => {
            captured = event;
            return true;
          },
          goalTimeout: noGoal,
        });
        const pending = requestApproval(request);
        // Longer than the budget — frozen while the prompt is open.
        await new Promise((r) => setTimeout(r, 120));
        expect(getToolApprovalBudget()?.signal.aborted).toBe(false);
        captured?.resolve({ allow: true });
        const outcome = await pending;
        expect(outcome.allow).toBe(true);
        return { callId: "2", content: "approved" };
      },
      { salvageGraceMs: 80, waitForApproval: true },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("approved");
    expect(captured?.signal).toBeDefined();
  });

  test("attaches goal timeout parameters to the gate event", async () => {
    let captured: PermissionGateEvent | undefined;
    const requestApproval = createGateRequestApproval({
      emitGate: (event) => {
        captured = event;
        return true;
      },
      goalTimeout: () => ({ timeoutMs: 15_000, timeoutMessage: "goal skip" }),
    });
    const pending = requestApproval(request);
    expect(captured?.timeoutMs).toBe(15_000);
    expect(captured?.timeoutMessage).toBe("goal skip");
    captured?.resolve({ allow: false });
    await pending;
  });

  test("resolves without a budget when called outside a tool run", async () => {
    let captured: PermissionGateEvent | undefined;
    const requestApproval = createGateRequestApproval({
      emitGate: (event) => {
        captured = event;
        return true;
      },
      goalTimeout: noGoal,
    });
    const pending = requestApproval(request);
    expect(captured?.signal).toBeUndefined();
    captured?.resolve({ allow: true });
    expect((await pending).allow).toBe(true);
  });
});
