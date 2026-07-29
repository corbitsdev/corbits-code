import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import { createDynamicToolRunner } from "./dynamic-tool-runner.js";
import {
  getToolApprovalBudget,
  isUsableToolExecuteResult,
  pauseToolApprovalBudget,
  preferExecuteSalvageAfterAbort,
  resolveToolExecutionTimeoutMs,
  resolveWaitForApproval,
  resumeToolApprovalBudget,
  runWithToolExecutionWatchdog,
  withPauseableTimeout,
  withTimeout,
} from "./tool-execution-watchdog.js";
import { formatToolExecutionTimeoutMessage } from "../plugins/tool-time-budget.js";

/** Short grace for hang-past-grace unit tests (keeps suite under bun default 5s). */
const TEST_SALVAGE_GRACE_MS = 80;

const stringTool = (name: string, handler: () => Promise<string>): AgentTool => ({
  kind: "string",
  definition: {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  handler: async () => handler(),
});

describe("tool execution watchdog", () => {
  test("resolveToolExecutionTimeoutMs clamps to max", () => {
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 9_999_999, maxMs: 100 })).toBe(100);
  });

  test("withTimeout dispose clears timer without leaving hung state", async () => {
    const parent = new AbortController();
    const budget = withTimeout(parent.signal, 50);
    budget.dispose();
    await new Promise((r) => setTimeout(r, 80));
    expect(budget.signal.aborted).toBe(false);
  });

  test("fast tool completes under watchdog", async () => {
    const runner = createDynamicToolRunner([stringTool("ping", async () => "pong")], {
      defaultMs: 200,
    });
    const result = await runner.run(
      { id: "1", name: "ping", arguments: {} },
      new AbortController().signal,
    );
    expect(result.content).toBe("pong");
    expect(result.isError).toBeUndefined();
  });

  test("slow tool that never settles within grace returns user-visible timeout", async () => {
    const result = await runWithToolExecutionWatchdog(
      { id: "2", name: "slow", arguments: {} },
      new AbortController().signal,
      30,
      async () => {
        // Hang past budget + short test grace so the synthetic timeout wins.
        await new Promise((r) => setTimeout(r, TEST_SALVAGE_GRACE_MS + 100));
        return { callId: "2", content: "late" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(formatToolExecutionTimeoutMessage("slow", 30));
  });

  test("parent cancel prefers execute salvage body over synthetic aborted", async () => {
    const parent = new AbortController();
    const salvage = {
      callId: "3",
      content: "## Summary\nPartial work salvaged\n\n## Findings\ngate.ts mapped",
    };
    const pending = runWithToolExecutionWatchdog(
      { id: "3", name: "task", arguments: {} },
      parent.signal,
      5_000,
      async (signal) => {
        // Wait for the budget abort, then return structured salvage quickly.
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise((r) => setTimeout(r, 10));
        return salvage;
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS },
    );
    // Let execute attach its abort listener, then cancel.
    await new Promise((r) => setTimeout(r, 5));
    parent.abort();
    const afterAbort = await pending;
    expect(afterAbort.isError).not.toBe(true);
    expect(afterAbort.content).toContain("## Summary");
    expect(afterAbort.content).toContain("gate.ts mapped");
    expect(afterAbort.content).not.toBe("task aborted");
  });

  test("wall-clock outer timeout prefers late salvage within grace", async () => {
    const salvage = {
      callId: "4",
      content: "## Summary\nDeadline salvage\n\n## Findings\npartial findings",
    };
    const result = await runWithToolExecutionWatchdog(
      { id: "4", name: "task", arguments: {} },
      new AbortController().signal,
      30,
      async (signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // Settle well inside the salvage grace after abort.
        await new Promise((r) => setTimeout(r, 20));
        return salvage;
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Deadline salvage");
    expect(result.content).toContain("## Summary");
  });

  test("parent abort still surfaces aborted when execute never settles", async () => {
    const parent = new AbortController();
    const pending = runWithToolExecutionWatchdog(
      { id: "5", name: "hang", arguments: {} },
      parent.signal,
      5_000,
      async () => {
        // Never resolve within grace.
        await new Promise(() => {});
        return { callId: "5", content: "ok" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS },
    );
    parent.abort();
    const afterAbort = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("watchdog did not settle after parent abort + grace")),
          TEST_SALVAGE_GRACE_MS + 500,
        ),
      ),
    ]);
    expect(afterAbort.isError).toBe(true);
    expect(afterAbort.content).toBe("hang aborted");
  });

  test("isUsableToolExecuteResult rejects errors and empty bodies", () => {
    expect(isUsableToolExecuteResult({ callId: "1", content: "ok" })).toBe(true);
    expect(isUsableToolExecuteResult({ callId: "1", content: "  " })).toBe(false);
    expect(isUsableToolExecuteResult({ callId: "1", content: "err", isError: true })).toBe(false);
  });

  test("preferExecuteSalvageAfterAbort returns body within grace", async () => {
    const body = { callId: "x", content: "## Summary\nsalvaged" };
    const promise = new Promise<typeof body>((resolve) => {
      setTimeout(() => resolve(body), 15);
    });
    const got = await preferExecuteSalvageAfterAbort(promise, 200);
    expect(got?.content).toContain("salvaged");
  });

  test("preferExecuteSalvageAfterAbort returns undefined past grace", async () => {
    const promise = new Promise<{ callId: string; content: string }>(() => {
      // never settles
    });
    const got = await preferExecuteSalvageAfterAbort(promise, 30);
    expect(got).toBeUndefined();
  });

  test("resolveWaitForApproval defaults true", () => {
    expect(resolveWaitForApproval(undefined)).toBe(true);
    expect(resolveWaitForApproval({})).toBe(true);
    expect(resolveWaitForApproval({ waitForApproval: false })).toBe(false);
  });

  test("withPauseableTimeout freezes remaining budget while paused", async () => {
    const parent = new AbortController();
    const budget = withPauseableTimeout(parent.signal, 80);
    budget.pause();
    await new Promise((r) => setTimeout(r, 120));
    expect(budget.signal.aborted).toBe(false);
    budget.resume();
    await new Promise((r) => setTimeout(r, 100));
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  test("pauseToolApprovalBudget freezes the active run budget during approval", async () => {
    let sawPause = false;
    const result = await runWithToolExecutionWatchdog(
      { id: "pause", name: "parked", arguments: {} },
      new AbortController().signal,
      60,
      async () => {
        pauseToolApprovalBudget();
        sawPause = true;
        // Longer than the budget — would time out if not paused.
        await new Promise((r) => setTimeout(r, 120));
        resumeToolApprovalBudget();
        return { callId: "pause", content: "approved-late" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
    );
    expect(sawPause).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("approved-late");
  });

  test("budget resume works from outside ALS (UI settle path)", async () => {
    // requestApproval's finish() runs on the React UI thread, not under the
    // tool ALS. Resume must use a captured handle, not ALS re-lookup.
    const result = await runWithToolExecutionWatchdog(
      { id: "ui", name: "parked", arguments: {} },
      new AbortController().signal,
      80,
      async () => {
        const budget = getToolApprovalBudget();
        expect(budget).toBeDefined();
        budget!.pause();
        // Simulate UI thread: resume via captured methods outside this ALS tick.
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            budget!.resume();
            resolve();
          }, 120);
        });
        // After resume, remaining budget (~80ms) should still cover a short run.
        await new Promise((r) => setTimeout(r, 20));
        return { callId: "ui", content: "approved-from-ui" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("approved-from-ui");
  });

  test("ALS re-lookup resume outside tool context is a no-op (regression guard)", async () => {
    const parent = new AbortController();
    const budget = withPauseableTimeout(parent.signal, 60);
    budget.pause();
    // Outside ALS: helpers must not throw and must not resume a foreign budget.
    resumeToolApprovalBudget();
    await new Promise((r) => setTimeout(r, 100));
    expect(budget.signal.aborted).toBe(false);
    budget.resume();
    await new Promise((r) => setTimeout(r, 80));
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  test("waitForApproval false lets budget expire while execute is parked", async () => {
    const result = await runWithToolExecutionWatchdog(
      { id: "tick", name: "parked", arguments: {} },
      new AbortController().signal,
      40,
      async (signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // Hang past salvage grace so synthetic timeout wins.
        await new Promise((r) => setTimeout(r, TEST_SALVAGE_GRACE_MS + 100));
        return { callId: "tick", content: "late" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: false },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(formatToolExecutionTimeoutMessage("parked", 40));
  });
});
