import { describe, expect, test } from "bun:test";
import { attachApprovalBudget, createGateRequestApproval } from "./request-approval.js";
import {
  getToolApprovalBudget,
  runWithToolExecutionWatchdog,
} from "./tool-execution-watchdog.js";
import type { PermissionGateEvent } from "./gate-events.js";
import type { ApprovalOutcome, PermissionRequest } from "../permission/types.js";

const request: PermissionRequest = {
  tool: "run_shell",
  action: "Run shell command",
  subject: "bun test",
  scopes: [],
};

const noTimeout = () => undefined;

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
          approvalTimeout: noTimeout,
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
          approvalTimeout: noTimeout,
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

  test("attaches auto-deny timeout parameters to the gate event", async () => {
    let captured: PermissionGateEvent | undefined;
    const requestApproval = createGateRequestApproval({
      emitGate: (event) => {
        captured = event;
        return true;
      },
      approvalTimeout: () => ({ timeoutMs: 15_000, timeoutMessage: "auto-deny skip" }),
    });
    const pending = requestApproval(request);
    expect(captured?.timeoutMs).toBe(15_000);
    expect(captured?.timeoutMessage).toBe("auto-deny skip");
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
      approvalTimeout: noTimeout,
    });
    const pending = requestApproval(request);
    expect(captured?.signal).toBeUndefined();
    captured?.resolve({ allow: true });
    expect((await pending).allow).toBe(true);
  });
});

// attachApprovalBudget is the mechanism createGateRequestApproval builds on
// (see above) and is reused directly by the operator-gate emission sites in
// runner.ts (ask_operator, MCP TOFU) — it must generalize past
// ApprovalOutcome and enforce single-resolution on its own.
describe("attachApprovalBudget", () => {
  test("pauses the budget at call time and resumes exactly once no matter how many times finish is called", async () => {
    let resolveCount = 0;
    let lastValue: string | undefined;
    await runWithToolExecutionWatchdog(
      { id: "3", name: "ask_operator", arguments: {} },
      new AbortController().signal,
      60,
      async () => {
        const { finish } = attachApprovalBudget<string>(
          (value) => {
            resolveCount += 1;
            lastValue = value;
          },
          { tool: "ask_operator", kind: "operator" },
        );
        // Longer than the budget — frozen while the question is pending,
        // exactly like the permission gate's budget pause.
        await new Promise((r) => setTimeout(r, 120));
        expect(getToolApprovalBudget()?.signal.aborted).toBe(false);
        finish("answered");
        finish("answered again");
        return { callId: "3", content: "done" };
      },
      { salvageGraceMs: 80, waitForApproval: true },
    );
    expect(resolveCount).toBe(1);
    expect(lastValue).toBe("answered");
  });

  test("has no signal when called outside a tool run", () => {
    let resolved: unknown;
    const { finish, signal } = attachApprovalBudget<string>((value) => {
      resolved = value;
    }, { tool: "ask_operator", kind: "operator" });
    expect(signal).toBeUndefined();
    finish("cancel");
    expect(resolved).toBe("cancel");
  });
});
