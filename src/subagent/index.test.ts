import { describe, expect, test } from "bun:test";

import { CodexAuthError } from "../auth/codex/session.js";
import { createPermissionGate } from "../permission/gate.js";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import {
  createTaskTool,
  createSubAgentRunController,
  createSubAgentSessionStore,
  createSubAgentSpawnRegistryPlugin,
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_REPEAT_LIMIT,
  disposeSubAgentSession,
  evaluateSubAgentStop,
  fingerprintToolCalls,
  forcedStopReport,
  formatSubAgentReport,
  nextToolCallStreak,
  parseSubAgentReport,
  appendDeadlineParentHint,
  appendNeverActedParentHint,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  subAgentToolName,
  SUBAGENT_DEADLINE_MARGIN_MS,
  SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS,
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

describe("sub-agent teardown", () => {
  test("disposeSubAgentSession closes agent, awaits stream, and disposes posix tools once", async () => {
    let closeCount = 0;
    let disposeCount = 0;
    let streamResolved = false;
    const agent = {
      close: async () => {
        closeCount += 1;
      },
    };
    const streamPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        streamResolved = true;
        resolve();
      }, 5);
    });
    const posixTools = {
      dispose: async () => {
        disposeCount += 1;
      },
    };
    const controller = new AbortController();
    const closeOnAbort = (): void => controller.abort();
    controller.signal.addEventListener("abort", closeOnAbort);

    await disposeSubAgentSession({
      signal: controller.signal,
      closeOnAbort,
      agent,
      streamPromise,
      posixTools,
    });

    expect(closeCount).toBe(1);
    expect(disposeCount).toBe(1);
    expect(streamResolved).toBe(true);
    await disposeSubAgentSession({ agent, posixTools });
    expect(disposeCount).toBe(2);
  });

  test("spawn registry tracks in-flight plugin tool calls", async () => {
    const { plugin, snapshot } = createSubAgentSpawnRegistryPlugin();
    expect(plugin.middleware).toBeDefined();
    const middleware = plugin.middleware!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = middleware(async (call) => {
      expect(snapshot().inFlightToolCalls).toBe(1);
      expect(snapshot().inFlightByTool.run_shell).toBe(1);
      await gate;
      return { callId: call.id, content: "ok" };
    });
    const run = handler(
      { id: "c1", name: "run_shell", arguments: { command: "true" } },
      new AbortController().signal,
    );
    expect(snapshot().inFlightToolCalls).toBe(1);
    release();
    await run;
    expect(snapshot().inFlightToolCalls).toBe(0);
  });

  test("teardown limits document missing global spawn registry", () => {
    expect(SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS).toContain("posixTools.dispose");
    expect(SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS).toContain("spawn hooks");
  });
});

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

  test("evaluateSubAgentStop returns complete when tools were used and the final turn has none", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        everHadToolCalls: true,
        turnsCompleted: 2,
        maxTurns: 10,
        consecutiveIdentical: 0,
        repeatLimit: 2,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop returns never-acted when the run never used tools", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        everHadToolCalls: false,
        turnsCompleted: 1,
        maxTurns: 10,
        consecutiveIdentical: 0,
        repeatLimit: 2,
      }),
    ).toBe("never-acted");
  });

  test("evaluateSubAgentStop prefers no-progress over turn-budget", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        everHadToolCalls: true,
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
        everHadToolCalls: true,
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
        everHadToolCalls: true,
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

    const neverActed = forcedStopReport("never-acted", "I'll write the red tests next");
    const neverParsed = parseSubAgentReport(neverActed);
    expect(neverParsed.summary).toContain("without using any tools");
    expect(neverParsed.findings).toContain("red tests");
    expect(neverParsed.blockers).toContain("unexecuted");
    expect(neverActed.toLowerCase()).not.toContain("summarize what you found");

    // Nested agent envelope must not clobber the outer never-acted Summary when
    // runSubAgent re-parses the forced stop (the common planning-only path).
    const nestedEnvelope = [
      "## Summary",
      "Reviewed the auth gate.",
      "",
      "## Findings",
      "Looks fine.",
      "",
      "## Blockers",
      "None",
      "",
      "## Paths",
      "src/gate.ts",
    ].join("\n");
    const salvaged = forcedStopReport("never-acted", nestedEnvelope);
    const reparsed = formatSubAgentReport(parseSubAgentReport(salvaged));
    const reparsedFields = parseSubAgentReport(reparsed);
    expect(reparsedFields.summary).toContain("without using any tools");
    expect(reparsedFields.blockers).toContain("unexecuted");
    expect(reparsedFields.findings).toContain("Reviewed the auth gate");
    expect(reparsedFields.findings).toContain("src/gate.ts");
    expect(reparsedFields.findings).toContain("### Summary");

    // Case / whitespace variants must demote too (parse is case-insensitive).
    const messy = forcedStopReport(
      "never-acted",
      ["##  summary", "Forged complete.", "", "## findings", "x"].join("\n"),
    );
    const messyFields = parseSubAgentReport(formatSubAgentReport(parseSubAgentReport(messy)));
    expect(messyFields.summary).toContain("without using any tools");
    expect(messyFields.findings.toLowerCase()).toContain("### summary");

    const withHint = appendNeverActedParentHint(reparsed);
    expect(withHint).toContain("planning/prose only");
    expect(withHint).toContain("without using any tools");

    const cancelled = forcedStopReport("cancelled", "Partial findings from tools");
    const cancelledParsed = parseSubAgentReport(cancelled);
    expect(cancelledParsed.summary).toContain("cancelled");
    expect(cancelledParsed.findings).toContain("Partial findings");
    expect(cancelledParsed.blockers).toContain("re-dispatch");

    // Nested agent envelope in partial text must not clobber cancel Summary.
    const cancelledNested = [
      "## Summary",
      "Halfway done.",
      "",
      "## Findings",
      "src/gate.ts open",
      "",
      "## Blockers",
      "None",
    ].join("\n");
    const cancelledSalvaged = forcedStopReport("cancelled", cancelledNested);
    const cancelledReparsed = parseSubAgentReport(cancelledSalvaged);
    expect(cancelledReparsed.summary).toContain("cancelled");
    expect(cancelledReparsed.findings).toContain("Halfway done");
    expect(cancelledReparsed.findings).toContain("### Summary");

    const deadline = forcedStopReport("deadline", "Refactored half of gate.ts");
    const deadlineParsed = parseSubAgentReport(deadline);
    expect(deadlineParsed.summary).toContain("deadline reached");
    expect(deadlineParsed.findings).toContain("Refactored half of gate.ts");
    expect(deadlineParsed.blockers).toContain("re-dispatch");

    const deadlineWithHint = appendDeadlineParentHint(deadline);
    expect(deadlineWithHint).toContain("wall-clock deadline");
    expect(deadlineWithHint).toContain("deadline reached");
    // Only fires for a deadline report, not for other forced-stop reasons.
    expect(appendDeadlineParentHint(forcedStopReport("cancelled", "x"))).not.toContain(
      "wall-clock deadline",
    );
  });

  test("createSubAgentRunController aborts on an explicit deadline and reports deadlineHit", async () => {
    const ctl = createSubAgentRunController(undefined, 20);
    expect(ctl.signal.aborted).toBe(false);
    expect(ctl.deadlineHit()).toBe(false);
    await new Promise<void>((resolve) => {
      ctl.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(ctl.signal.aborted).toBe(true);
    expect(ctl.deadlineHit()).toBe(true);
    ctl.dispose();
  });

  test("createSubAgentRunController arms no timer when deadlineMs is omitted", async () => {
    const ctl = createSubAgentRunController(undefined);
    expect(ctl.signal.aborted).toBe(false);
    expect(ctl.deadlineHit()).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctl.signal.aborted).toBe(false);
    expect(ctl.deadlineHit()).toBe(false);
    ctl.dispose();
  });

  test("createSubAgentRunController prefers an explicit parent cancel over the deadline", async () => {
    const parent = new AbortController();
    const ctl = createSubAgentRunController(parent.signal, 60_000);
    parent.abort(new Error("operator cancel"));
    expect(ctl.signal.aborted).toBe(true);
    expect(ctl.deadlineHit()).toBe(false);
    ctl.dispose();
  });

  test("createSubAgentRunController does not mark deadlineHit when timer fires after parent cancel", async () => {
    const parent = new AbortController();
    const ctl = createSubAgentRunController(parent.signal, 20);
    parent.abort(new Error("operator cancel"));
    expect(ctl.signal.aborted).toBe(true);
    expect(ctl.deadlineHit()).toBe(false);
    // Intentionally do not dispose yet — let the timer callback run.
    await new Promise((r) => setTimeout(r, 50));
    expect(ctl.deadlineHit()).toBe(false);
    ctl.dispose();
  });

  test("resolveSubAgentDeadlineMs clamps an explicit deadline below a lowered outer watchdog", () => {
    const loweredOuterWatchdogMs = 120_000;
    const clamped = resolveSubAgentDeadlineMs(600_000, loweredOuterWatchdogMs);
    expect(clamped).toBeLessThan(loweredOuterWatchdogMs);
    expect(clamped).toBe(loweredOuterWatchdogMs - SUBAGENT_DEADLINE_MARGIN_MS);
  });

  test("resolveSubAgentDeadlineMs keeps a short explicit deadline when the outer watchdog is high", () => {
    expect(resolveSubAgentDeadlineMs(45_000, 660_000)).toBe(45_000);
  });

  test("resolveSubAgentDeadlineMs skips arming when outer watchdog is at or below the margin", () => {
    expect(resolveSubAgentDeadlineMs(5_000, 5_000)).toBeUndefined();
    expect(resolveSubAgentDeadlineMs(5_000, SUBAGENT_DEADLINE_MARGIN_MS)).toBeUndefined();
    // Outer just above margin: ceiling is 1 — never exceeds outer.
    expect(resolveSubAgentDeadlineMs(5_000, SUBAGENT_DEADLINE_MARGIN_MS + 1)).toBe(1);
  });

  test("preferCompletedSubAgentReply keeps a non-empty reply over late cancel", () => {
    expect(preferCompletedSubAgentReply("## Summary\nDone")).toBe("keep-reply");
    expect(preferCompletedSubAgentReply("  mapped gate.ts  ")).toBe("keep-reply");
  });

  test("preferCompletedSubAgentReply honors abort when send returned empty", () => {
    expect(preferCompletedSubAgentReply("")).toBe("honor-abort");
    expect(preferCompletedSubAgentReply("   ")).toBe("honor-abort");
  });

  test("resolveSubAgentCatchOutcome always salvages a deadline hit, even with zero output", () => {
    // Zero-output edge case: no tool calls, no partial text, but an opt-in
    // deadline fired. It must not fall through to a bare rethrow.
    expect(
      resolveSubAgentCatchOutcome({ deadlineHit: true, hadProgress: false }),
    ).toBe("salvage-deadline");
  });

  test("resolveSubAgentCatchOutcome salvages a mid-run operator cancel that made progress", () => {
    expect(
      resolveSubAgentCatchOutcome({ deadlineHit: false, hadProgress: true }),
    ).toBe("salvage-cancelled");
  });

  test("resolveSubAgentCatchOutcome rethrows a pre-progress operator cancel", () => {
    expect(
      resolveSubAgentCatchOutcome({ deadlineHit: false, hadProgress: false }),
    ).toBe("rethrow");
  });

  test("partialTextFromEvent reads stream inference.done data.turn content", () => {
    const text = partialTextFromEvent({
      type: "inference.done",
      seq: 1,
      data: {
        turn: {
          role: "assistant",
          content: [
            { type: "text", text: "Mapped src/gate.ts" },
            { type: "tool_call", id: "1", name: "read_file", arguments: {} },
          ],
          model: "m",
          timestamp: 0,
        },
        usage: {},
        source: {},
      },
    } as Parameters<typeof partialTextFromEvent>[0]);
    expect(text).toBe("Mapped src/gate.ts");

    // Wrong shape (director inbound turn at top level) must not silently match.
    const wrong = partialTextFromEvent({
      type: "inference.done",
      turn: {
        content: [{ type: "text", text: "should not appear" }],
      },
    } as unknown as Parameters<typeof partialTextFromEvent>[0]);
    expect(wrong).toBeNull();

    expect(partialTextFromEvent({ type: "tool.start", seq: 1, data: {} } as Parameters<typeof partialTextFromEvent>[0])).toBeNull();
  });

  test("subAgentToolName reads tool.start data.call.name", () => {
    expect(
      subAgentToolName({
        type: "tool.start",
        seq: 1,
        data: { call: { name: "read_file" } },
      } as Parameters<typeof subAgentToolName>[0]),
    ).toBe("read_file");
    expect(
      subAgentToolName({
        type: "inference.done",
        seq: 1,
        data: {},
      } as Parameters<typeof subAgentToolName>[0]),
    ).toBeNull();
  });
});


describe("createTaskTool", () => {
  test("does not inherit a bogus parent-session maxTurns dep on the task tool", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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

  test("task tier rebuilds provider from settings and wins over profile inference", async () => {
    let captured: RunSubAgentParams | undefined;
    const settings = {
      providers: {
        "clever-p": { baseURL: "http://clever", apiKey: "k", models: ["clever-model"] },
        "profile-p": { baseURL: "http://profile", apiKey: "k", models: ["profile-model", "pinned-model"] },
      },
      tiers: {
        clever: { provider: "clever-p", model: "clever-model" },
        standard: { provider: "profile-p", model: "profile-model" },
      },
    };
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      settings,
      profiles: [
        {
          id: "deep",
          tier: "standard",
          inference: { order: [{ provider: "profile-p", model: "pinned-model" }] },
        },
      ],
      run: async (params) => {
        captured = params;
        return "done";
      },
    });
    await callTask(tool, {
      description: "tier-override",
      prompt: "x",
      agent: "deep",
      tier: "clever",
    });
    expect(captured?.provider.providerName).toBe("clever-p");
    expect(captured?.provider.model).toBe("clever-model");
    expect(captured?.tier).toBe("clever");
  });

  test("profile tier still applies when task omits tier", async () => {
    let captured: RunSubAgentParams | undefined;
    const settings = {
      providers: {
        "profile-p": { baseURL: "http://profile", apiKey: "k", models: ["profile-model"] },
      },
      tiers: {
        standard: { provider: "profile-p", model: "profile-model" },
      },
    };
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      settings,
      profiles: [{ id: "deep", tier: "standard" }],
      run: async (params) => {
        captured = params;
        return "done";
      },
    });
    await callTask(tool, { description: "profile-tier", prompt: "x", agent: "deep" });
    expect(captured?.provider.providerName).toBe("profile-p");
    expect(captured?.provider.model).toBe("profile-model");
    expect(captured?.tier).toBe("standard");
  });

  test("unconfigured task tier fails closed", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      settings: { providers: {} },
      run: async () => "done",
    });
    const out = await callTask(tool, {
      description: "bad-tier",
      prompt: "x",
      tier: "clever",
    });
    expect(out).toContain("Error:");
    expect(out).toContain("clever");
    expect(out).toContain("not configured");
  });

  test("task tier targeting OAuth provider resolves via live catalog", async () => {
    let captured: RunSubAgentParams | undefined;
    // Disk settings omit OAuth providers (they are never persisted) but tiers
    // still name them. The live catalog supplies the missing provider entry.
    const diskSettings = {
      providers: {
        "codex/home": {
          baseURL: "https://chatgpt.com/backend-api",
          apiKey: "codex-token",
          models: ["gpt-5.3-codex"],
        },
      },
      tiers: {
        clever: { provider: "xai/work", model: "grok-4" },
        standard: { provider: "xai/work", model: "grok-3" },
        fast: { provider: "xai/work", model: "grok-3-mini" },
      },
    };
    const catalog = [
      {
        name: "codex/home",
        baseURL: "https://chatgpt.com/backend-api",
        apiKey: "codex-token",
        models: ["gpt-5.3-codex"],
        codexProfile: "home",
      },
      {
        name: "xai/work",
        baseURL: "https://api.x.ai/v1",
        apiKey: "xai-token",
        models: ["grok-4", "grok-3", "grok-3-mini"],
        xaiProfile: "work",
      },
    ];
    const parentProvider = {
      providerName: "codex/home",
      baseURL: "https://chatgpt.com/backend-api",
      apiKey: "codex-token",
      model: "gpt-5.3-codex",
    };
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider: parentProvider,
      settings: diskSettings,
      catalog,
      run: async (params) => {
        captured = params;
        return "done";
      },
    });
    await callTask(tool, {
      description: "oauth-tier",
      prompt: "x",
      tier: "clever",
    });
    expect(captured?.provider.providerName).toBe("xai/work");
    expect(captured?.provider.model).toBe("grok-4");
    expect(captured?.provider.apiKey).toBe("xai-token");
    expect(captured?.tier).toBe("clever");
  });

  test("task tier targeting OAuth fails closed when catalog lacks the provider", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      settings: {
        providers: {
          "api-only": { baseURL: "http://api", apiKey: "k", models: ["m"] },
        },
        tiers: {
          clever: { provider: "xai/missing", model: "grok-4" },
        },
      },
      catalog: [
        {
          name: "api-only",
          baseURL: "http://api",
          apiKey: "k",
          models: ["m"],
        },
      ],
      run: async () => "done",
    });
    const out = await callTask(tool, {
      description: "missing-oauth",
      prompt: "x",
      tier: "clever",
    });
    expect(out).toContain("Error:");
    expect(out).toContain("not configured");
  });

  test("rejects task maxTurns above the cap", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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
      getWorkdirBase: () => "/repo/.corbits",
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
        // Injected run returns salvage after cancel-with-progress; task must keep it.
        return forcedStopReport("cancelled", "partial from tools");
      },
    });
    const out = await callTask(tool, { description: "signal", prompt: "x" }, parent.signal);
    expect(linkedAbort).toBe(true);
    expect(captured?.signal?.aborted).toBe(true);
    expect(out).toContain("cancelled");
    expect(out).toContain("partial from tools");
    expect(out).toContain("## Summary");
  });

  test("keeps a returned result when strip cancel races after run resolves", async () => {
    const sessions = createSubAgentSessionStore();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      sessions,
      run: async () => {
        const row = sessions.list().find((s) => s.description === "race");
        if (row !== undefined) sessions.cancel(row.id, "Cancelled by operator");
        return forcedStopReport("cancelled", "salvaged work");
      },
    });
    const out = await callTask(tool, { description: "race", prompt: "x" });
    expect(out).toContain("salvaged work");
    expect(out).toContain("## Summary");
    expect(out).not.toBe('Sub-agent "race" cancelled by operator.');
    const row = sessions.list().find((s) => s.description === "race");
    expect(row?.status).toBe("cancelled");
  });

  test("pre-progress AbortError still surfaces as bare cancel", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const out = await callTask(tool, { description: "pre-progress", prompt: "x" });
    expect(out).toContain("cancelled by operator");
    expect(out).not.toContain("## Summary");
  });

  test("injected cancel salvage is reported to the parent with Summary/Findings", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => forcedStopReport("cancelled", "Found path in gate.ts"),
    });
    const out = await callTask(tool, { description: "salvage", prompt: "x" });
    expect(out).toContain("## Summary");
    expect(out).toContain("## Findings");
    expect(out).toContain("gate.ts");
    expect(out).toContain("cancelled");
  });

  test("inference auth failure marks tool error and fails the sub-agent session", async () => {
    const sessions = createSubAgentSessionStore();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      sessions,
      run: async () => {
        throw new CodexAuthError("work", "refresh-failed", "401 Unauthorized");
      },
    });
    if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
    const result = await tool.handler(
      {
        id: "auth-call",
        name: "task",
        arguments: { description: "auth probe", prompt: "x" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    const toolText = String(result.content);
    expect(toolText).toContain("Re-authenticate");
    // Exactly one Error: prefix on the tool result (formatter is bare).
    expect(toolText.startsWith("Error: ")).toBe(true);
    expect(toolText.includes("Error: Error:")).toBe(false);
    const row = sessions.list().find((s) => s.description === "auth probe");
    expect(row?.status).toBe("failed");
    // session.error is bare; report entry is prefixed once by SessionStore.fail.
    expect(row?.error?.startsWith("Error:")).toBe(false);
    expect(row?.error).toContain("Re-authenticate");
    const report = row?.entries.find((e) => e.kind === "report");
    expect(report?.content.startsWith("Error: ")).toBe(true);
    expect(report?.content.includes("Error: Error:")).toBe(false);
  });

  test("forwards deadlineMs to run and appends parent hint on deadline salvage", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      deadlineMs: 45_000,
      run: async (params) => {
        captured = params;
        return forcedStopReport("deadline", "partial before wall clock");
      },
    });
    const out = await callTask(tool, { description: "deadline", prompt: "x" });
    expect(captured?.deadlineMs).toBe(45_000);
    expect(out).toContain("## Summary");
    expect(out).toContain("deadline");
    expect(out).toContain("partial before wall clock");
    expect(out).toContain("explicit wall-clock deadline");
  });

  test("dynamic runner + task: parent cancel keeps salvage body, not task aborted", async () => {
    const parent = new AbortController();
    const task = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async (params) => {
        // Wait for linked cancel, then return structured salvage.
        await new Promise<void>((resolve) => {
          if (params.signal?.aborted) {
            resolve();
            return;
          }
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await new Promise((r) => setTimeout(r, 10));
        return forcedStopReport("cancelled", "Found path in gate.ts");
      },
    });
    const runner = createDynamicToolRunner([task], { defaultMs: 10_000 });
    const pending = runner.run(
      { id: "int-1", name: "task", arguments: { description: "race", prompt: "x" } },
      parent.signal,
    );
    await new Promise((r) => setTimeout(r, 15));
    parent.abort();
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(String(result.content)).toContain("## Summary");
    expect(String(result.content)).toContain("gate.ts");
    expect(String(result.content)).not.toBe("task aborted");
    expect(String(result.content)).not.toContain("task aborted");
  });
});
