import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import { createDynamicToolRunner } from "./dynamic-tool-runner.js";
import {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
  RUN_SHELL_WATCHDOG_SLACK_MS,
  getToolApprovalBudget,
  isUsableToolExecuteResult,
  preferExecuteSalvageAfterAbort,
  resolveToolExecutionTimeoutMs,
  resolveWaitForApproval,
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

  test("spawn_agent with no settings timeout is unbounded", () => {
    expect(
      resolveToolExecutionTimeoutMs(undefined, { id: "1", name: "spawn_agent", arguments: {} }),
    ).toBeUndefined();
  });

  test("wait_agents with no settings timeout is unbounded", () => {
    expect(
      resolveToolExecutionTimeoutMs(undefined, { id: "1", name: "wait_agents", arguments: {} }),
    ).toBeUndefined();
  });

  test("spawn_agent is exempt from the settings watchdog", () => {
    // Dispatch returns immediately; the generic per-tool budget must not abort it.
    const call = { id: "1", name: "spawn_agent", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 660_000 }, call)).toBeUndefined();
    expect(
      resolveToolExecutionTimeoutMs({ defaultMs: 660_000, maxMs: 1_800_000 }, call),
    ).toBeUndefined();
  });

  test("wait_agents is exempt from the settings watchdog", () => {
    // Collect can outlast settings.tools.timeoutMs while workers still run.
    const call = { id: "1", name: "wait_agents", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 660_000 }, call)).toBeUndefined();
    expect(
      resolveToolExecutionTimeoutMs({ defaultMs: 660_000, maxMs: 1_800_000 }, call),
    ).toBeUndefined();
  });

  test("ask_director with no settings timeout is unbounded", () => {
    expect(
      resolveToolExecutionTimeoutMs(undefined, { id: "1", name: "ask_director", arguments: {} }),
    ).toBeUndefined();
  });

  test("ask_director is exempt from the settings watchdog", () => {
    // Awaiting the director can outlast settings.tools.timeoutMs; aborting
    // would cancel the pending ask so later send_input steers instead of answering.
    const call = { id: "1", name: "ask_director", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 660_000 }, call)).toBeUndefined();
    expect(
      resolveToolExecutionTimeoutMs({ defaultMs: 660_000, maxMs: 1_800_000 }, call),
    ).toBeUndefined();
  });

  test("wait_agents run outlasting the generic budget completes with its own report", async () => {
    const runner = createDynamicToolRunner(
      [
        stringTool("wait_agents", async () => {
          // Slow but progressing: runs well past the 30ms generic budget.
          await new Promise((r) => setTimeout(r, 120));
          return "## Summary\nworker report";
        }),
      ],
      { defaultMs: 30 },
    );
    const result = await runner.run(
      { id: "t", name: "wait_agents", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("worker report");
  });

  test("ask_director run outlasting the generic budget completes with its own answer", async () => {
    const runner = createDynamicToolRunner(
      [
        stringTool("ask_director", async () => {
          await new Promise((r) => setTimeout(r, 120));
          return "src/foo.ts";
        }),
      ],
      { defaultMs: 30 },
    );
    const result = await runner.run(
      { id: "t", name: "ask_director", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("src/foo.ts");
  });

  test("omitted config does not arm a default watchdog", () => {
    expect(resolveToolExecutionTimeoutMs(undefined)).toBeUndefined();
    expect(resolveToolExecutionTimeoutMs({})).toBeUndefined();
    expect(resolveToolExecutionTimeoutMs({ waitForApproval: true })).toBeUndefined();
  });

  test("settings timeout without max clamps to MAX_TOOL_EXECUTION_TIMEOUT_MS", () => {
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 9_999_999 })).toBe(
      MAX_TOOL_EXECUTION_TIMEOUT_MS,
    );
  });

  test("run_shell requested 5-hour timeout is not clamped", () => {
    const requested = 18_000_000;
    const call = { id: "1", name: "run_shell", arguments: { timeout: requested } };
    const ms = resolveToolExecutionTimeoutMs(undefined, call);
    expect(ms).toBe(requested + RUN_SHELL_WATCHDOG_SLACK_MS);
    expect(ms).toBeGreaterThan(MAX_TOOL_EXECUTION_TIMEOUT_MS);
  });

  test("tools.maxTimeoutMs does not cap a longer requested run_shell timeout", () => {
    const requested = 18_000_000;
    const call = { id: "1", name: "run_shell", arguments: { timeout: requested } };
    const ms = resolveToolExecutionTimeoutMs({ defaultMs: 660_000, maxMs: 100_000 }, call);
    expect(ms).toBe(requested + RUN_SHELL_WATCHDOG_SLACK_MS);
  });

  test("omitted run_shell timeout is unbounded (shell-guard also has no default)", () => {
    expect(
      resolveToolExecutionTimeoutMs(undefined, { id: "1", name: "run_shell", arguments: {} }),
    ).toBeUndefined();
    expect(
      resolveToolExecutionTimeoutMs(undefined, {
        id: "1",
        name: "run_shell",
        arguments: { timeout: 0 },
      }),
    ).toBeUndefined();
  });

  test("omitted run_shell timeout still honors settings default", () => {
    expect(
      resolveToolExecutionTimeoutMs(
        { defaultMs: 60_000, maxMs: 100_000 },
        { id: "1", name: "run_shell", arguments: {} },
      ),
    ).toBe(60_000);
  });

  test("non-shell tools still honor tools.maxTimeoutMs", () => {
    const call = { id: "1", name: "read_file", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 9_999_999, maxMs: 100 }, call)).toBe(100);
  });

  test("mcp tool calls are bounded by default even with no config (CL-6895)", () => {
    const call = { id: "1", name: "mcp__linear__get_issue", arguments: {} };
    expect(resolveToolExecutionTimeoutMs(undefined, call)).toBe(DEFAULT_MCP_TOOL_TIMEOUT_MS);
    expect(resolveToolExecutionTimeoutMs({}, call)).toBe(DEFAULT_MCP_TOOL_TIMEOUT_MS);
  });

  test("mcp.timeoutMs overrides the mcp default", () => {
    const call = { id: "1", name: "mcp__linear__get_issue", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ mcpTimeoutMs: 45_000 }, call)).toBe(45_000);
  });

  test("tools.defaultMs alone (no mcpTimeoutMs) does not affect the mcp default", () => {
    const call = { id: "1", name: "mcp__linear__get_issue", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ defaultMs: 5_000 }, call)).toBe(
      DEFAULT_MCP_TOOL_TIMEOUT_MS,
    );
  });

  test("tools.maxTimeoutMs still caps a longer mcp.timeoutMs override", () => {
    const call = { id: "1", name: "mcp__linear__get_issue", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ mcpTimeoutMs: 9_999_999, maxMs: 100 }, call)).toBe(100);
  });

  test("non-positive or non-finite mcp.timeoutMs falls back to the default instead of a 1ms timeout", () => {
    const call = { id: "1", name: "mcp__linear__get_issue", arguments: {} };
    expect(resolveToolExecutionTimeoutMs({ mcpTimeoutMs: 0 }, call)).toBe(
      DEFAULT_MCP_TOOL_TIMEOUT_MS,
    );
    expect(resolveToolExecutionTimeoutMs({ mcpTimeoutMs: -5 }, call)).toBe(
      DEFAULT_MCP_TOOL_TIMEOUT_MS,
    );
    expect(resolveToolExecutionTimeoutMs({ mcpTimeoutMs: NaN }, call)).toBe(
      DEFAULT_MCP_TOOL_TIMEOUT_MS,
    );
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
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(formatToolExecutionTimeoutMessage("slow", 30));
  });

  test("mcp tool whose promise never resolves times out with a model-reactable error, turn continues", async () => {
    const runner = createDynamicToolRunner(
      [
        stringTool(
          "mcp__linear__get_issue",
          () => new Promise<string>(() => {}), // never resolves — wedged server
        ),
      ],
      { mcpTimeoutMs: 30 },
    );
    const result = await runner.run(
      { id: "1", name: "mcp__linear__get_issue", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("mcp__linear__get_issue timed out after 0s");
    expect(result.content).toContain("the server may be wedged");
  }, 10_000);

  test("concurrent mcp tool calls each time out independently", async () => {
    const runner = createDynamicToolRunner(
      [
        stringTool("mcp__linear__get_issue", () => new Promise<string>(() => {})),
        stringTool("mcp__linear__list_issues", async () => "ok"),
      ],
      { mcpTimeoutMs: 30 },
    );
    const signal = new AbortController().signal;
    const [hung1, hung2, fast] = await Promise.all([
      runner.run({ id: "1", name: "mcp__linear__get_issue", arguments: {} }, signal),
      runner.run({ id: "2", name: "mcp__linear__get_issue", arguments: {} }, signal),
      runner.run({ id: "3", name: "mcp__linear__list_issues", arguments: {} }, signal),
    ]);
    expect(hung1.isError).toBe(true);
    expect(hung1.content).toContain("mcp__linear__get_issue timed out");
    expect(hung2.isError).toBe(true);
    expect(hung2.content).toContain("mcp__linear__get_issue timed out");
    expect(fast.content).toBe("ok");
    expect(fast.isError).toBeUndefined();
  }, 10_000);

  test("mcp.timeoutMs: 0 does not instantly time out an mcp tool call (falls back to the default)", async () => {
    const runner = createDynamicToolRunner(
      [stringTool("mcp__linear__get_issue", async () => "ok")],
      { mcpTimeoutMs: 0 },
    );
    const result = await runner.run(
      { id: "1", name: "mcp__linear__get_issue", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("ok");
  }, 10_000);

  test("parent cancel prefers execute salvage body over synthetic aborted", async () => {
    const parent = new AbortController();
    const salvage = {
      callId: "3",
      content: "## Summary\nPartial work salvaged\n\n## Findings\ngate.ts mapped",
    };
    const pending = runWithToolExecutionWatchdog(
      { id: "3", name: "wait_agents", arguments: {} },
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
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
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
      { id: "4", name: "wait_agents", arguments: {} },
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
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
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
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
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

  test("undefined timeout lets a 50ms tool complete", async () => {
    const result = await runWithToolExecutionWatchdog(
      { id: "unbounded", name: "wait_agents", arguments: {} },
      new AbortController().signal,
      undefined,
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { callId: "unbounded", content: "ok" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("ok");
  });

  test("undefined timeout still surfaces parent abort", async () => {
    const parent = new AbortController();
    const pending = runWithToolExecutionWatchdog(
      { id: "unbounded-hang", name: "wait_agents", arguments: {} },
      parent.signal,
      undefined,
      async () => {
        await new Promise(() => {});
        return { callId: "unbounded-hang", content: "ok" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
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
    expect(afterAbort.content).toBe("wait_agents aborted");
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
    const token = budget.pause();
    await new Promise((r) => setTimeout(r, 120));
    expect(budget.signal.aborted).toBe(false);
    budget.resume(token);
    await new Promise((r) => setTimeout(r, 100));
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  test("pausing the ALS budget freezes the active run during approval", async () => {
    const result = await runWithToolExecutionWatchdog(
      { id: "pause", name: "parked", arguments: {} },
      new AbortController().signal,
      60,
      async () => {
        const budget = getToolApprovalBudget();
        expect(budget).toBeDefined();
        const token = budget!.pause();
        // Longer than the budget — would time out if not paused.
        await new Promise((r) => setTimeout(r, 120));
        budget!.resume(token);
        return { callId: "pause", content: "approved-late" };
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
    );
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
        const token = budget!.pause();
        // Simulate UI thread: resume via captured methods outside this ALS tick.
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            budget!.resume(token);
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

  test("no approval budget is visible outside a watchdog run", () => {
    // The gate must capture the handle inside the tool run; outside the ALS
    // there is nothing to pause or resume.
    expect(getToolApprovalBudget()).toBeUndefined();
  });

  test("pause ceiling resumes a frozen budget with no prompt on screen", async () => {
    // A gate queued behind an overlay (or emitted with no listener) never
    // resumes the budget; the ceiling bounds how long the clock stays frozen.
    const parent = new AbortController();
    const budget = withPauseableTimeout(parent.signal, 50, 40);
    budget.pause();
    await new Promise((r) => setTimeout(r, 30));
    expect(budget.signal.aborted).toBe(false);
    // Ceiling fires at 40ms, remaining ~50ms budget then expires on its own.
    await new Promise((r) => setTimeout(r, 100));
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  test("resume before the pause ceiling clears the ceiling timer", async () => {
    const parent = new AbortController();
    const budget = withPauseableTimeout(parent.signal, 100, 30);
    const firstToken = budget.pause();
    await new Promise((r) => setTimeout(r, 10));
    budget.resume(firstToken);
    const secondToken = budget.pause();
    // A fresh pause restarts the ceiling; forced resume must not double-fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(budget.signal.aborted).toBe(false);
    budget.resume(secondToken);
    await new Promise((r) => setTimeout(r, 130));
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
  });

  test("stale resume after a forced ceiling resume does not unfreeze a newer pause", async () => {
    // Ceiling fires at 120ms and force-resumes prompt A's pause. Prompt B then
    // opens its own pause on the now-running clock. When prompt A's orphaned
    // resume() finally arrives, it must not decrement prompt B's pause depth
    // or cancel B's own ceiling timer — B should get its own full ceiling
    // window before the budget clock resumes on its account.
    const parent = new AbortController();
    const budget = withPauseableTimeout(parent.signal, 240, 120);
    const tokenA = budget.pause(); // prompt A, ceiling armed to fire at ~120ms
    await new Promise((r) => setTimeout(r, 200)); // past A's ceiling
    const tokenB = budget.pause(); // prompt B opens at ~200ms, ceiling armed to ~320ms
    budget.resume(tokenA); // stale resume from prompt A must be a no-op
    // If the stale resume wrongly unfroze the clock (bug: it also cancels B's
    // ceiling timer), the budget aborts around 360ms. With the fix, B's own
    // ceiling doesn't fire until ~320ms, so the budget is still frozen here.
    await new Promise((r) => setTimeout(r, 200));
    expect(budget.signal.aborted).toBe(false);
    // B's ceiling eventually force-resumes it on its own account.
    await new Promise((r) => setTimeout(r, 90));
    expect(budget.signal.aborted).toBe(true);
    budget.resume(tokenB);
    budget.dispose();
  });

  test("nested watchdog pause freezes the enclosing budget too", async () => {
    // wait_agents: outer watchdog wraps the parent collect call; each child tool
    // call opens its own nested watchdog. A permission prompt during the child
    // captures the innermost budget — pausing it must also freeze the parent
    // budget, or the parent keeps ticking under the modal.
    const result = await runWithToolExecutionWatchdog(
      { id: "outer", name: "wait_agents", arguments: {} },
      new AbortController().signal,
      60,
      async (outerSignal) => {
        const outerBudget = getToolApprovalBudget();
        const inner = await runWithToolExecutionWatchdog(
          { id: "inner", name: "child", arguments: {} },
          outerSignal,
          500,
          async () => {
            const budget = getToolApprovalBudget();
            expect(budget).toBeDefined();
            const token = budget!.pause();
            // Longer than the outer budget — outer must be frozen too.
            await new Promise((r) => setTimeout(r, 120));
            budget!.resume(token);
            return { callId: "inner", content: "child-ok" };
          },
          { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
        );
        // The parent budget must have been frozen during the child's pause —
        // salvage grace could still return the body even if it expired.
        expect(outerBudget?.signal.aborted).toBe(false);
        return inner;
      },
      { salvageGraceMs: TEST_SALVAGE_GRACE_MS, waitForApproval: true },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("child-ok");
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
