import { describe, expect, test } from "bun:test";

import { createPermissionGate } from "../permission/gate.js";
import {
  createTaskTool,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_REPEAT_LIMIT,
  evaluateSubAgentStop,
  fingerprintToolCalls,
  forcedStopReport,
  nextToolCallStreak,
  parseSubAgentReport,
  subAgentNoProgress,
  subAgentTurnLimitExceeded,
  type RunSubAgentParams,
} from "./index.js";


const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

async function callTask(
  tool: ReturnType<typeof createTaskTool>,
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  // createTaskTool returns a full-handler AgentTool (call + signal → ToolResult).
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    { id: "call-1", name: "task", arguments: args },
    signal,
  );
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

describe("sub-agent stop helpers", () => {
  test("default turn budget is tight enough to bound runaway cost", () => {
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(30);
    expect(subAgentTurnLimitExceeded(DEFAULT_SUBAGENT_MAX_TURNS, DEFAULT_SUBAGENT_MAX_TURNS)).toBe(true);
    expect(subAgentTurnLimitExceeded(DEFAULT_SUBAGENT_MAX_TURNS - 1, DEFAULT_SUBAGENT_MAX_TURNS)).toBe(false);
  });

  test("no-progress trips at the default repeat limit", () => {
    expect(DEFAULT_SUBAGENT_REPEAT_LIMIT).toBe(2);
    expect(subAgentNoProgress(1, DEFAULT_SUBAGENT_REPEAT_LIMIT)).toBe(false);
    expect(subAgentNoProgress(2, DEFAULT_SUBAGENT_REPEAT_LIMIT)).toBe(true);
  });

  test("fingerprint is null when a turn has no tool calls", () => {
    expect(fingerprintToolCalls([{ type: "text" }])).toBeNull();
  });

  test("fingerprint is stable across argument key order and multi-call order", () => {
    const a = fingerprintToolCalls([
      { type: "tool_call", name: "read_file", arguments: { path: "a.ts", offset: 1 } },
      { type: "tool_call", name: "grep", arguments: { pattern: "x", path: "src" } },
    ]);
    const b = fingerprintToolCalls([
      { type: "tool_call", name: "grep", arguments: { path: "src", pattern: "x" } },
      { type: "tool_call", name: "read_file", arguments: { offset: 1, path: "a.ts" } },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  test("fingerprint normalizes JSON-string arguments", () => {
    const objectArgs = fingerprintToolCalls([
      { type: "tool_call", name: "read_file", arguments: { path: "a.ts" } },
    ]);
    const stringArgs = fingerprintToolCalls([
      { type: "tool_call", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
    ]);
    expect(objectArgs).toBe(stringArgs);
  });

  test("changing arguments produces a different fingerprint", () => {
    const first = fingerprintToolCalls([
      { type: "tool_call", name: "read_file", arguments: { path: "a.ts" } },
    ]);
    const second = fingerprintToolCalls([
      { type: "tool_call", name: "read_file", arguments: { path: "b.ts" } },
    ]);
    expect(first).not.toBe(second);
  });

  test("evaluateSubAgentStop returns complete when there are no tool calls", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        turnsCompleted: 1,
        maxTurns: 10,
        consecutiveIdentical: 0,
        repeatLimit: 2,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop prefers no-progress over turn-budget", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        turnsCompleted: 10,
        maxTurns: 10,
        consecutiveIdentical: 2,
        repeatLimit: 2,
      }),
    ).toBe("no-progress");
  });

  test("evaluateSubAgentStop trips turn-budget when the leaf is still making progress", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        turnsCompleted: 10,
        maxTurns: 10,
        consecutiveIdentical: 1,
        repeatLimit: 2,
      }),
    ).toBe("turn-budget");
  });

  test("evaluateSubAgentStop keeps running while fingerprints change under budget", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        turnsCompleted: 5,
        maxTurns: 10,
        consecutiveIdentical: 1,
        repeatLimit: 2,
      }),
    ).toBeNull();
  });

  test("nextToolCallStreak increments on identical fingerprints and resets on change", () => {
    let streak = nextToolCallStreak(
      { lastFingerprint: undefined, consecutiveIdentical: 0 },
      "read_file:{\"path\":\"a.ts\"}",
    );
    expect(streak.consecutiveIdentical).toBe(1);
    streak = nextToolCallStreak(streak, "read_file:{\"path\":\"a.ts\"}");
    expect(streak.consecutiveIdentical).toBe(2);
    streak = nextToolCallStreak(streak, "read_file:{\"path\":\"b.ts\"}");
    expect(streak.consecutiveIdentical).toBe(1);
    streak = nextToolCallStreak(streak, null);
    expect(streak).toEqual({ lastFingerprint: undefined, consecutiveIdentical: 0 });
  });

  test("forcedStopReport is a real envelope with salvage findings, not a summarize instruction", () => {
    const noProgress = forcedStopReport("no-progress", "Found auth in gate.ts");
    const parsed = parseSubAgentReport(noProgress);
    expect(parsed.summary).toContain("no progress");
    expect(parsed.findings).toContain("gate.ts");
    expect(parsed.blockers.length).toBeGreaterThan(0);
    expect(noProgress.toLowerCase()).not.toContain("summarize what you found");

    const budget = forcedStopReport("turn-budget", "");
    const budgetParsed = parseSubAgentReport(budget);
    expect(budgetParsed.summary).toContain("Turn budget");
    expect(budgetParsed.findings).toContain("no partial findings");
    expect(budget.toLowerCase()).not.toContain("summarize progress");
  });
});

describe("createTaskTool", () => {
  test("does not inherit a bogus parent-session maxTurns dep on the task tool", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      maxTurns: 25,
      run: async (params) => {
        captured = params;
        return "done";
      },
    } as Parameters<typeof createTaskTool>[0] & { maxTurns: number });

    const result = await callTask(tool, { description: "Investigate", prompt: "Do the work" });

    expect(result).toContain("done");
    expect(captured).toBeDefined();
    expect(captured?.maxTurns).toBe(30);
  });

  test("uses settings subagentMaxTurns when task and profile omit maxTurns", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      settings: { providers: {}, subagentMaxTurns: 42 },
      run: async (params) => {
        captured = params;
        return "done";
      },
    });

    await callTask(tool, { description: "Settings default", prompt: "Work" });

    expect(captured?.maxTurns).toBe(42);
  });

  test("forwards task maxTurns to runSubAgent", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      run: async (params) => {
        captured = params;
        return "done";
      },
    });

    await callTask(tool, {
      description: "Long job",
      prompt: "Work",
      maxTurns: 50,
    });

    expect(captured?.maxTurns).toBe(50);
  });

  test("rejects task maxTurns above the cap", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      run: async () => "done",
    });

    const result = await callTask(tool, {
      description: "Too long",
      prompt: "Work",
      maxTurns: 101,
    });

    expect(result).toContain("Error:");
    expect(result).toContain("100");
  });

  test("uses profile maxTurns when task omits maxTurns", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      profiles: [{ id: "deep", maxTurns: 45 }],
      run: async (params) => {
        captured = params;
        return "done";
      },
    });

    await callTask(tool, {
      description: "Profile budget",
      prompt: "Work",
      agent: "deep",
    });

    expect(captured?.maxTurns).toBe(45);
  });

  test("task maxTurns overrides profile maxTurns", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      profiles: [{ id: "deep", maxTurns: 45 }],
      run: async (params) => {
        captured = params;
        return "done";
      },
    });

    await callTask(tool, {
      description: "Override",
      prompt: "Work",
      agent: "deep",
      maxTurns: 60,
    });

    expect(captured?.maxTurns).toBe(60);
  });

  test("appends parent hint when the worker hits turn budget", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      run: async () => forcedStopReport("turn-budget", "partial"),
    });

    const result = await callTask(tool, { description: "Budget", prompt: "Work" });

    expect(result).toContain("turn budget");
    expect(result).toContain("Turn budget reached");
  });

  test("forwards sandbox deps (permission gate and inherited MCP tools) to runSubAgent", async () => {
    const inherited = [{
      definition: { name: "mcp__srv__tool", description: "Test MCP tool", inputSchema: {} },
      kind: "string" as const,
      handler: async () => "ok",
    }];
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      inheritMcpTools: () => inherited,
      run: async (params) => {
        captured = params;
        return "done";
      },
    });

    await callTask(tool, { description: "MCP parity", prompt: "check tools" });

    expect(captured?.permissionGate).toBe(testPermissionGate);
    expect(captured?.inheritMcpTools?.()).toEqual(inherited);
  });

  test("forwards a dedicated child abort signal linked to the parent tool signal", async () => {
    let captured: RunSubAgentParams | undefined;
    let linkedAbort = false;
    const parent = new AbortController();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      run: async (params) => {
        captured = params;
        expect(params.signal).toBeDefined();
        expect(params.signal).not.toBe(parent.signal);
        expect(params.signal?.aborted).toBe(false);
        // Abort while the run is in-flight so the parent→child link is still live.
        await new Promise<void>((resolve) => {
          params.signal!.addEventListener(
            "abort",
            () => {
              linkedAbort = true;
              resolve();
            },
            { once: true },
          );
          parent.abort();
        });
        return "done";
      },
    });
    const out = await callTask(tool, { description: "signal", prompt: "x" }, parent.signal);
    expect(linkedAbort).toBe(true);
    expect(captured?.signal?.aborted).toBe(true);
    // Abort during run is reported as cancel, not a completed report.
    expect(out).toContain("cancelled by operator");
  });
});
