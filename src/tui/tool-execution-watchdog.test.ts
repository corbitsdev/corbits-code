import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@intx/agent";
import { createDynamicToolRunner } from "./dynamic-tool-runner.js";
import {
  resolveToolExecutionTimeoutMs,
  runWithToolExecutionWatchdog,
  withTimeout,
} from "./tool-execution-watchdog.js";
import { formatToolExecutionTimeoutMessage } from "../plugins/tool-time-budget.js";

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

  test("slow tool returns user-visible timeout", async () => {
    const runner = createDynamicToolRunner(
      [
        stringTool("slow", async () => {
          await new Promise((r) => setTimeout(r, 200));
          return "late";
        }),
      ],
      { defaultMs: 30 },
    );
    const result = await runner.run(
      { id: "2", name: "slow", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(formatToolExecutionTimeoutMessage("slow", 30));
  });

  test("parent abort surfaces aborted outcome", async () => {
    const parent = new AbortController();
    const pending = runWithToolExecutionWatchdog(
      { id: "3", name: "hang", arguments: {} },
      parent.signal,
      5_000,
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { callId: "3", content: "ok" };
      },
    );
    parent.abort();
    const afterAbort = await pending;
    expect(afterAbort.isError).toBe(true);
    expect(afterAbort.content).toBe("hang aborted");
  });
});