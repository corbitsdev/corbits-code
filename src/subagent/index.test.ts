import { describe, expect, test } from "bun:test";

import { CodexAuthError } from "../auth/codex/session.js";
import { createPermissionGate } from "../permission/gate.js";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import {
  buildDispatchBrief,
  coreSubAgentWebTools,
  createTaskTool,
  createSubAgentRunController,
  createSubAgentSessionStore,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
  evaluateSubAgentStop,
  forcedStopReport,
  formatSubAgentReport,
  parseSubAgentReport,
  stopReasonFromReport,
  appendSubAgentParentHints,
  createBriefDispatchLedger,
  fingerprintTaskBrief,
  classifyBriefSalvage,
  EMPTY_THRASH_STATE,
  nextThrashState,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  shouldRequireEvidence,
  subAgentToolName,
  SUBAGENT_DEADLINE_MARGIN_MS,
  SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS,
  SubAgentDirector,
  TaskToolArgs,
  type RunSubAgentParams,
} from "./index.js";

import { type } from "arktype";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";

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
  const result = await tool.handler({ id: "call-1", name: "task", arguments: args }, signal);
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
  test("evaluateSubAgentStop returns incomplete-report when the final turn has no tool calls and no envelope", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: "",
      }),
    ).toBe("incomplete-report");
  });

  const SUMMARY_ONLY_NARRATION = [
    "## Summary",
    "Checking whether Skywalker write-tool unmount is tested...",
    "Checking those next.",
  ].join("\n");

  const FULL_REPORT_ENVELOPE = [
    "## Summary",
    "Reviewed gate.ts.",
    "",
    "## Findings",
    "Auth lives in gate.ts.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/gate.ts",
  ].join("\n");

  test("evaluateSubAgentStop returns incomplete-report for Summary-only tool-less narration after tools", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: SUMMARY_ONLY_NARRATION,
      }),
    ).toBe("incomplete-report");
  });

  test("evaluateSubAgentStop returns incomplete-report-stop for Summary-only after the wrap-up nudge", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: SUMMARY_ONLY_NARRATION,
        incompleteReportNudgeFired: true,
      }),
    ).toBe("incomplete-report-stop");
  });

  test("evaluateSubAgentStop returns complete for tool-less after tools with all four headings", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: FULL_REPORT_ENVELOPE,
      }),
    ).toBe("complete");
  });

  test("shouldRequireEvidence is armed for the critique director id", () => {
    expect(shouldRequireEvidence({ directorId: "critique" })).toBe(true);
  });

  test("shouldRequireEvidence is off for greybeard even with intent=review", () => {
    expect(
      shouldRequireEvidence({
        intent: "review",
        directorId: "greybeard",
      }),
    ).toBe(false);
  });

  test("shouldRequireEvidence is off when no directorId is resolved", () => {
    expect(shouldRequireEvidence({ intent: "review" })).toBe(false);
  });

  test("evaluateSubAgentStop does not complete a review/critique with empty readCounts even with a full envelope", () => {
    const thrashState = {
      totalToolCalls: 1,
      readCounts: new Map(),
      editedPaths: new Set<string>(),
    };
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: FULL_REPORT_ENVELOPE,
        thrashState,
        requireEvidence: true,
      }),
    ).toBe("incomplete-report");
  });

  test("evaluateSubAgentStop completes a review when readCounts has file evidence", () => {
    const thrashState = {
      totalToolCalls: 1,
      readCounts: new Map([["src/gate.ts", 1]]),
      editedPaths: new Set<string>(),
    };
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: FULL_REPORT_ENVELOPE,
        thrashState,
        requireEvidence: true,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop completes greybeard spawn-only envelope when requireEvidence is off", () => {
    const thrashState = {
      totalToolCalls: 1,
      readCounts: new Map(),
      editedPaths: new Set<string>(),
    };
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: FULL_REPORT_ENVELOPE,
        thrashState,
        requireEvidence: false,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop does not stop for many unique reads while still calling tools", () => {
    let thrash = EMPTY_THRASH_STATE;
    for (let i = 0; i < 200; i++) {
      thrash = nextThrashState(thrash, [
        { type: "tool_call", name: "read_file", arguments: { path: `src/f${i}.ts` } },
      ]);
    }
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        lastAssistantText: "",
        thrashState: thrash,
      }),
    ).toBeNull();
  });

  test("evaluateSubAgentStop keeps running while the worker is still calling tools", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        lastAssistantText: "",
      }),
    ).toBeNull();
  });

  test("re-read pressure no longer stops a worker (CL-6936)", () => {
    let thrash = EMPTY_THRASH_STATE;
    thrash = nextThrashState(thrash, [
      { type: "tool_call", name: "edit_file", arguments: { path: "a.ts" } },
    ]);
    for (let i = 0; i < 8; i++) {
      thrash = nextThrashState(thrash, [
        { type: "tool_call", name: "read_file", arguments: { path: "a.ts" } },
      ]);
    }
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        lastAssistantText: "",
        thrashState: thrash,
      }),
    ).toBeNull();
  });

  test("evaluateSubAgentStop multi-file unique reads do not thrash", () => {
    let thrash = EMPTY_THRASH_STATE;
    for (let i = 0; i < 12; i++) {
      thrash = nextThrashState(thrash, [
        { type: "tool_call", name: "read_file", arguments: { path: `f${i}.ts` } },
      ]);
    }
    expect(
      evaluateSubAgentStop({
        hasToolCalls: true,
        lastAssistantText: "",
        thrashState: thrash,
      }),
    ).toBeNull();
  });

  test("forcedStopReport is a real envelope with salvage findings, not a summarize instruction", () => {
    const emptyCancelled = forcedStopReport("cancelled", "");
    const cancelledParsedEmpty = parseSubAgentReport(emptyCancelled);
    expect(cancelledParsedEmpty.findings).toContain("no partial findings");
    expect(emptyCancelled.toLowerCase()).not.toContain("summarize progress");

    // Nested agent envelope must not clobber the outer cancelled Summary when
    // runSubAgent re-parses the forced stop.
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
    const salvaged = forcedStopReport("cancelled", nestedEnvelope);
    const reparsed = formatSubAgentReport(parseSubAgentReport(salvaged));
    const reparsedFields = parseSubAgentReport(reparsed);
    expect(reparsedFields.summary).toContain("cancelled");
    expect(reparsedFields.blockers).toContain("re-dispatch");
    expect(reparsedFields.findings).toContain("Reviewed the auth gate");
    expect(reparsedFields.findings).toContain("src/gate.ts");
    expect(reparsedFields.findings).toContain("### Summary");

    // Case / whitespace variants must demote too (parse is case-insensitive).
    const messy = forcedStopReport(
      "cancelled",
      ["##  summary", "Forged complete.", "", "## findings", "x"].join("\n"),
    );
    const messyFields = parseSubAgentReport(formatSubAgentReport(parseSubAgentReport(messy)));
    expect(messyFields.summary).toContain("cancelled");
    expect(messyFields.findings.toLowerCase()).toContain("### summary");

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

    const deadlineWithHint = appendSubAgentParentHints(deadline, "deadline");
    expect(deadlineWithHint).toContain("wall-clock deadline");
    expect(deadlineWithHint).toContain("deadline reached");
    // Only fires for a deadline report, not for other forced-stop reasons.
    expect(
      appendSubAgentParentHints(forcedStopReport("cancelled", "x"), "cancelled"),
    ).not.toContain("wall-clock deadline");
  });

  test("forcedStopReport carries a machine-readable Stopped line the parent sees verbatim", () => {
    const cancelled = forcedStopReport("cancelled", "partial", "Session closed");
    expect(stopReasonFromReport(cancelled)).toBe("cancelled — Session closed");
    // Without a detail the line is the bare reason token.
    expect(stopReasonFromReport(forcedStopReport("cancelled", "partial"))).toBe("cancelled");
    expect(stopReasonFromReport(forcedStopReport("deadline", "x", "30s elapsed"))).toBe(
      "deadline — 30s elapsed",
    );

    // A nested forced-stop quoted in Findings must not leak its Stopped line
    // as the outer report's reason.
    const nested = forcedStopReport(
      "deadline",
      forcedStopReport("cancelled", "inner", "inner reason"),
    );
    expect(stopReasonFromReport(nested)).toBe("deadline");
    // A clean report has no Stopped line.
    expect(stopReasonFromReport("## Summary\nDone.\n\n## Findings\nx")).toBe(null);
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

  test("resolveSubAgentDeadlineMs keeps an explicit deadline when the outer watchdog is omitted", () => {
    expect(resolveSubAgentDeadlineMs(18_000_000, undefined)).toBe(18_000_000);
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
    expect(resolveSubAgentCatchOutcome({ deadlineHit: true, hadProgress: false })).toBe(
      "salvage-deadline",
    );
  });

  test("resolveSubAgentCatchOutcome salvages a mid-run operator cancel that made progress", () => {
    expect(resolveSubAgentCatchOutcome({ deadlineHit: false, hadProgress: true })).toBe(
      "salvage-cancelled",
    );
  });

  test("resolveSubAgentCatchOutcome rethrows a pre-progress operator cancel", () => {
    expect(resolveSubAgentCatchOutcome({ deadlineHit: false, hadProgress: false })).toBe("rethrow");
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

    expect(
      partialTextFromEvent({ type: "tool.start", seq: 1, data: {} } as Parameters<
        typeof partialTextFromEvent
      >[0]),
    ).toBeNull();
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

describe("thrash edge cases", () => {
  const read = (path: string, extra: Record<string, unknown> = {}) => ({
    type: "tool_call",
    name: "read_file",
    arguments: { path, ...extra },
  });
  const edit = (path: string) => ({
    type: "tool_call",
    name: "edit_file",
    arguments: { path, old_string: "a", new_string: "b" },
  });
  const grep = (pattern: string) => ({
    type: "tool_call",
    name: "grep",
    arguments: { pattern, path: "src" },
  });
  const stop = (thrashState = EMPTY_THRASH_STATE) =>
    evaluateSubAgentStop({
      hasToolCalls: true,
      lastAssistantText: "",
      thrashState,
    });

  test("an ordinary edit-then-verify loop is not a stop", () => {
    // edit -> read-back verify, four times, on one file: legitimate iteration.
    let s = EMPTY_THRASH_STATE;
    for (let i = 0; i < 4; i++) {
      s = nextThrashState(s, [edit("hot.ts")]);
      s = nextThrashState(s, [read("hot.ts")]);
    }
    expect(stop(s)).toBeNull();
  });

  test("chunked reads of a large edited file are not a stop", () => {
    let s = EMPTY_THRASH_STATE;
    s = nextThrashState(s, [edit("big.ts")]);
    s = nextThrashState(s, [
      read("big.ts", { offset: 0, limit: 500 }),
      read("big.ts", { offset: 500, limit: 500 }),
      read("big.ts", { offset: 1000, limit: 500 }),
      read("big.ts", { offset: 1500, limit: 500 }),
    ]);
    expect(stop(s)).toBeNull();
  });

  test("re-reading the same chunk repeatedly is not a stop (CL-6936)", () => {
    let s = EMPTY_THRASH_STATE;
    s = nextThrashState(s, [edit("big.ts")]);
    for (let i = 0; i < 8; i++) {
      s = nextThrashState(s, [read("big.ts", { offset: 0, limit: 500 })]);
    }
    s = nextThrashState(s, [grep("p1"), grep("p2"), grep("p3")]);
    expect(stop(s)).toBeNull();
  });
});

describe("SubAgentDirector stall management", () => {
  const mockState: ReactorState = { turns: [] } as unknown as ReactorState;

  function makeCapabilities(): ReactorCapabilities {
    return {
      infer: (options) =>
        ({ type: "infer", ...(options !== undefined ? { options } : {}) }) as ReactorAction,
      executeTools: (calls, parallel, addToHistory) =>
        ({ type: "execute_tools", calls, parallel, addToHistory }) as ReactorAction,
      suspend: (gate) => ({ type: "suspend", gate }) as ReactorAction,
      fork: (mode, forkId) => ({ type: "fork", mode, forkId }) as ReactorAction,
      emit: (eventType, data) => ({ type: "emit", eventType, data }) as ReactorAction,
      reply: (content) => ({ type: "reply", content }) as ReactorAction,
      checkpoint: (message = "") => ({ type: "checkpoint", message }) as ReactorAction,
      compact: (compactor, reason) => ({ type: "compact", compactor, reason }) as ReactorAction,
      wait: () => ({ type: "wait" }) as ReactorAction,
      done: () => ({ type: "done" }) as ReactorAction,
    };
  }

  function toolCallDoneEvent(id: string): ReactorInboundEvent {
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        model: "test",
        timestamp: 0,
        content: [{ type: "tool_call", id, name: "read_file", arguments: { path: "a.ts" } }],
      },
      usage: { input: 0, output: 0 },
      source: "test",
    } as unknown as ReactorInboundEvent;
  }

  function toolDoneEvent(callId: string): ReactorInboundEvent {
    return {
      type: "tool.done",
      result: { callId, content: "ok" },
    } as unknown as ReactorInboundEvent;
  }

  function stallPing(): ReactorInboundEvent {
    return { type: "message.received", message: { content: "" } } as unknown as ReactorInboundEvent;
  }

  function actionsArray(result: ReactorAction | ReactorAction[]): ReactorAction[] {
    return Array.isArray(result) ? result : [result];
  }

  test("no nudge fires before the stall timeout elapses", async () => {
    let now = 0;
    const director = new SubAgentDirector("system", [], undefined, 1000, () => now);
    const capabilities = makeCapabilities();

    await director.decide(toolCallDoneEvent("tc-1"), mockState, capabilities);
    await director.decide(toolDoneEvent("tc-1"), mockState, capabilities);

    now += 500; // under the 1000ms stall timeout
    const actions = actionsArray(await director.decide(stallPing(), mockState, capabilities));
    expect(actions.some((a) => a.type === "reply")).toBe(false);
    const infer = actions.find((a) => a.type === "infer");
    const options =
      infer?.type === "infer"
        ? (infer.options as { ephemeralTurns?: unknown[] } | undefined)
        : undefined;
    expect(options?.ephemeralTurns).toBeUndefined();
  });

  test("first stall past the timeout gets one continuation nudge", async () => {
    let now = 0;
    const director = new SubAgentDirector("system", [], undefined, 1000, () => now);
    const capabilities = makeCapabilities();

    await director.decide(toolCallDoneEvent("tc-1"), mockState, capabilities);
    await director.decide(toolDoneEvent("tc-1"), mockState, capabilities);

    now += 1500; // past the stall timeout
    const actions = actionsArray(await director.decide(stallPing(), mockState, capabilities));
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    if (infer === undefined || infer.type !== "infer") throw new Error("expected infer action");
    const ephemeralTurns = (
      infer.options as { ephemeralTurns?: { content: { text?: string }[] }[] }
    )?.ephemeralTurns;
    expect(ephemeralTurns?.[0]?.content?.[0]?.text).toContain("background");
  });

  test("a second consecutive stall escalates to the salvage report", async () => {
    let now = 0;
    const director = new SubAgentDirector("system", [], undefined, 1000, () => now);
    const capabilities = makeCapabilities();

    await director.decide(toolCallDoneEvent("tc-1"), mockState, capabilities);
    await director.decide(toolDoneEvent("tc-1"), mockState, capabilities);

    now += 1500;
    await director.decide(stallPing(), mockState, capabilities); // first stall: nudge

    now += 1500; // no activity since the nudge
    const actions = actionsArray(await director.decide(stallPing(), mockState, capabilities));
    const reply = actions.find((a) => a.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("Stopped after a long silence with no tool activity.");
    expect(actions.some((a) => a.type === "infer")).toBe(false);
  });

  test("real activity between pings resets the stall streak", async () => {
    let now = 0;
    const director = new SubAgentDirector("system", [], undefined, 1000, () => now);
    const capabilities = makeCapabilities();

    await director.decide(toolCallDoneEvent("tc-1"), mockState, capabilities);
    await director.decide(toolDoneEvent("tc-1"), mockState, capabilities);

    now += 1500;
    await director.decide(stallPing(), mockState, capabilities); // first stall: nudge

    // Real activity lands before the next ping — this must not count as a
    // second consecutive stall.
    now += 100;
    await director.decide(toolCallDoneEvent("tc-2"), mockState, capabilities);
    await director.decide(toolDoneEvent("tc-2"), mockState, capabilities);

    now += 1500;
    const actions = actionsArray(await director.decide(stallPing(), mockState, capabilities));
    const infer = actions.find((a) => a.type === "infer");
    expect(infer).toBeDefined();
    if (infer === undefined || infer.type !== "infer") throw new Error("expected infer action");
    const ephemeralTurns = (infer.options as { ephemeralTurns?: unknown[] } | undefined)
      ?.ephemeralTurns;
    // A fresh first stall nudges again rather than immediately escalating.
    expect(ephemeralTurns).toBeDefined();
  });
});

describe("createTaskTool", () => {
  test("handler does not resolve until run() resolves; result includes the full report", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const report = "## Summary\nThe work is done.";
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      profiles: [{ id: "leaf" }],
      run: async () => {
        await gate;
        return { report };
      },
    });

    const pending = callTask(tool, {
      description: "Investigate",
      prompt: "Do the work",
      agent: "leaf",
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    const result = await pending;
    expect(settled).toBe(true);
    expect(result).toContain('Sub-agent "');
    expect(result).toContain(report);
    expect(result).toContain("## Summary");
  });

  test("profile inference rebuilds provider from settings", async () => {
    let captured: RunSubAgentParams | undefined;
    const settings = {
      providers: {
        "profile-p": {
          baseURL: "http://profile",
          apiKey: "k",
          models: ["profile-model", "pinned-model"],
        },
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
          inference: { order: [{ provider: "profile-p", model: "pinned-model" }] },
        },
      ],
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });
    await callTask(tool, {
      description: "profile-inference",
      prompt: "x",
      agent: "deep",
    });
    expect(captured?.provider.providerName).toBe("profile-p");
    expect(captured?.provider.model).toBe("pinned-model");
  });

  test("profile inference targeting OAuth provider resolves via live catalog", async () => {
    let captured: RunSubAgentParams | undefined;
    const diskSettings = {
      providers: {},
    };
    const catalog = [
      {
        name: "xai/work",
        baseURL: "https://api.x.ai/v1",
        apiKey: "xai-token",
        models: ["grok-4"],
        xaiProfile: "work",
      },
    ];
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      settings: diskSettings,
      catalog,
      profiles: [
        {
          id: "deep",
          inference: { order: [{ provider: "xai/work", model: "grok-4" }] },
        },
      ],
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });
    await callTask(tool, { description: "oauth-profile-inference", prompt: "x", agent: "deep" });
    expect(captured?.provider.providerName).toBe("xai/work");
    expect(captured?.provider.model).toBe("grok-4");
    expect(captured?.provider.apiKey).toBe("xai-token");
  });

  test("profile inference fails closed when pinned and unavailable", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      settings: {
        providers: {
          "api-only": { baseURL: "http://api", apiKey: "k", models: ["m"] },
        },
      },
      profiles: [
        {
          id: "deep",
          inference: { mode: "pin", order: [{ provider: "xai/missing", model: "grok-4" }] },
        },
      ],
      run: async () => ({ report: "done" }),
    });
    const out = await callTask(tool, {
      description: "missing-oauth",
      prompt: "x",
      agent: "deep",
    });
    expect(out).toContain("Error:");
    expect(out).toContain("unavailable");
  });

  test("forwards sandbox deps (permission gate and inherited MCP tools) to runSubAgent", async () => {
    const inherited = [
      {
        definition: { name: "mcp__srv__tool", description: "Test MCP tool", inputSchema: {} },
        kind: "string" as const,
        handler: async () => "ok",
      },
    ];
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      inheritMcpTools: () => inherited,
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });

    await callTask(tool, { description: "MCP parity", prompt: "check tools", intent: "explore" });

    expect(captured?.permissionGate).toBe(testPermissionGate);
    expect(captured?.inheritMcpTools?.()).toEqual(inherited);
  });

  test("forwards shellEnv to runSubAgent so worker shell spawns get project env", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      shellEnv: { FOO: "bar" },
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });

    await callTask(tool, { description: "Env parity", prompt: "check env", intent: "explore" });

    expect(captured?.shellEnv).toEqual({ FOO: "bar" });
  });

  test("sub-agent toolset includes web_fetch and web_search", () => {
    const names = coreSubAgentWebTools().map((t) => t.definition.name);
    expect(names).toEqual(["web_fetch", "web_search"]);
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
        return {
          report: forcedStopReport("cancelled", "partial from tools"),
          stopReason: "cancelled",
        };
      },
    });
    const out = await callTask(
      tool,
      { description: "signal", prompt: "x", intent: "explore" },
      parent.signal,
    );
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
        return { report: forcedStopReport("cancelled", "salvaged work"), stopReason: "cancelled" };
      },
    });
    const out = await callTask(tool, { description: "race", prompt: "x", intent: "explore" });
    expect(out).toContain("salvaged work");
    expect(out).toContain("## Summary");
    expect(out).not.toBe('Sub-agent "race" cancelled by operator.');
    const row = sessions.list().find((s) => s.description === "race");
    expect(row?.status).toBe("cancelled");
  });

  test("pre-progress cancel surfaces the recorded cancel reason to the parent", async () => {
    const sessions = createSubAgentSessionStore();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      sessions,
      run: async () => {
        const row = sessions.list().find((s) => s.description === "reasoned");
        if (row !== undefined) sessions.cancel(row.id, "Session closed");
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const out = await callTask(tool, { description: "reasoned", prompt: "x", intent: "explore" });
    expect(out).toContain("Stopped: cancelled — Session closed");
    const row = sessions.list().find((s) => s.description === "reasoned");
    expect(row?.status).toBe("cancelled");
    expect(row?.stopReason).toBe("cancelled — Session closed");
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
    const out = await callTask(tool, {
      description: "pre-progress",
      prompt: "x",
      intent: "explore",
    });
    expect(out).toContain("cancelled by operator");
    expect(out).not.toContain("## Summary");
  });

  test("injected cancel salvage is reported to the parent with Summary/Findings", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => ({
        report: forcedStopReport("cancelled", "Found path in gate.ts"),
        stopReason: "cancelled",
      }),
    });
    const out = await callTask(tool, { description: "salvage", prompt: "x", intent: "explore" });
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
        arguments: { description: "auth probe", prompt: "x", intent: "explore" },
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
        return {
          report: forcedStopReport("deadline", "partial before wall clock"),
          stopReason: "deadline",
        };
      },
    });
    const out = await callTask(tool, { description: "deadline", prompt: "x", intent: "explore" });
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
        return {
          report: forcedStopReport("cancelled", "Found path in gate.ts"),
          stopReason: "cancelled",
        };
      },
    });
    const runner = createDynamicToolRunner([task], { defaultMs: 10_000 });
    const pending = runner.run(
      {
        id: "int-1",
        name: "task",
        arguments: { description: "race", prompt: "x", intent: "explore" },
      },
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

  test("forwards intent, success_criteria, do_not, and report_focus to run", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });

    await callTask(tool, {
      description: "typed-contract",
      prompt: "Implement the feature",
      intent: "implement",
      success_criteria: ["tests pass", "typecheck green"],
      do_not: ["commit", "refactor unrelated"],
      report_focus: "files changed and test counts",
      goals: ["seed step one"],
    });

    expect(captured?.intent).toBe("implement");
    expect(captured?.successCriteria).toEqual(["tests pass", "typecheck green"]);
    expect(captured?.doNot).toEqual(["commit", "refactor unrelated"]);
    expect(captured?.reportFocus).toBe("files changed and test counts");
    expect(captured?.goals).toEqual(["seed step one"]);
  });

  test("omits typed spawn fields when not provided (back-compat)", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async (params) => {
        captured = params;
        return { report: "done" };
      },
    });

    await callTask(tool, { description: "legacy", prompt: "Do the work", intent: "explore" });

    // Intent is required to select a director; other typed spawn fields stay optional.
    expect(captured?.intent).toBe("explore");
    expect(captured?.successCriteria).toBeUndefined();
    expect(captured?.doNot).toBeUndefined();
    expect(captured?.reportFocus).toBeUndefined();
    expect(captured?.goals).toBeUndefined();
  });

  test("rejects invalid intent via schema", async () => {
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      run: async () => ({ report: "done" }),
    });
    const out = await callTask(tool, {
      description: "bad-intent",
      prompt: "x",
      intent: "ship-it",
    });
    expect(out).toContain("Error:");
  });
});

describe("TaskToolArgs schema", () => {
  test("accepts optional typed spawn fields", () => {
    const parsed = TaskToolArgs({
      description: "job",
      prompt: "do it",
      intent: "explore",
      success_criteria: ["mapped callers"],
      do_not: ["edit files"],
      report_focus: "call graph",
    });
    expect(parsed instanceof type.errors).toBe(false);
    if (parsed instanceof type.errors) throw new Error(parsed.summary);
    expect(parsed.intent).toBe("explore");
    expect(parsed.success_criteria).toEqual(["mapped callers"]);
    expect(parsed.do_not).toEqual(["edit files"]);
    expect(parsed.report_focus).toBe("call graph");
  });

  test("accepts legacy description+prompt only", () => {
    const parsed = TaskToolArgs({ description: "job", prompt: "do it" });
    expect(parsed instanceof type.errors).toBe(false);
  });

  test("rejects unknown intent", () => {
    const parsed = TaskToolArgs({
      description: "job",
      prompt: "do it",
      intent: "ship-it",
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  test("accepts every intent enum value", () => {
    for (const intent of ["explore", "implement", "review", "plan", "general"] as const) {
      const parsed = TaskToolArgs({ description: "j", prompt: "p", intent });
      expect(parsed instanceof type.errors).toBe(false);
    }
  });
});

describe("buildDispatchBrief typed spawn contract", () => {
  test("renders Intent, Success criteria, Do not, and report_focus only when set", () => {
    const full = buildDispatchBrief({
      description: "1a",
      prompt: "Implement typed spawn",
      context: "repo conventions",
      intent: "implement",
      successCriteria: ["typecheck green", "tests pass"],
      doNot: ["tool filtering", "director thrash"],
      goals: ["extend schema", "add tests"],
      reportFocus: "files and pass counts",
    });
    expect(full).toContain("## Intent\nimplement");
    expect(full).toContain("## Success criteria");
    expect(full).toContain("1. typecheck green");
    expect(full).toContain("2. tests pass");
    expect(full).toContain("## Do not");
    expect(full).toContain("1. tool filtering");
    expect(full).toContain("## Suggested checklist");
    expect(full).toContain("1. extend schema");
    expect(full).toContain("## Report shape");
    expect(full).toContain("Focus Findings on: files and pass counts");
    // Success criteria section precedes Suggested checklist.
    expect(full.indexOf("## Success criteria")).toBeLessThan(
      full.indexOf("## Suggested checklist"),
    );
  });

  test("omits Intent / Success criteria / Do not / report_focus when unset (back-compat)", () => {
    const legacy = buildDispatchBrief({
      description: "legacy",
      prompt: "Do the work",
      goals: ["step one"],
    });
    expect(legacy).toContain("# Dispatch brief: legacy");
    expect(legacy).toContain("## Goal\nDo the work");
    expect(legacy).toContain("## Suggested checklist");
    expect(legacy).toContain("1. step one");
    expect(legacy).toContain("## Report shape");
    expect(legacy).not.toContain("## Intent");
    expect(legacy).not.toContain("## Success criteria");
    expect(legacy).not.toContain("## Do not");
    expect(legacy).not.toContain("Focus Findings on:");
  });

  test("keeps goals as checklist when success_criteria is also set", () => {
    const both = buildDispatchBrief({
      description: "both",
      prompt: "goal text",
      successCriteria: ["done check"],
      goals: ["manage_tasks seed"],
    });
    expect(both).toContain("## Success criteria");
    expect(both).toContain("1. done check");
    expect(both).toContain("## Suggested checklist");
    expect(both).toContain("1. manage_tasks seed");
  });
});

describe("brief re-dispatch ledger (CL-4343 / CL-5203)", () => {
  test("fingerprint ignores whitespace and omits description", () => {
    const a = fingerprintTaskBrief({
      prompt: "  map callers of X  ",
      intent: "explore",
      successCriteria: ["list callers"],
      doNot: ["edit code"],
    });
    const b = fingerprintTaskBrief({
      prompt: "map callers of X",
      intent: "explore",
      successCriteria: ["list callers"],
      doNot: ["edit code"],
    });
    expect(a).toBe(b);
    const changed = fingerprintTaskBrief({
      prompt: "map callers of X",
      intent: "implement",
      successCriteria: ["list callers"],
      doNot: ["edit code"],
    });
    expect(changed).not.toBe(a);
  });

  test("admit always succeeds, even after a repeated salvage on the same fingerprint", () => {
    const ledger = createBriefDispatchLedger();
    const fp = fingerprintTaskBrief({ prompt: "fix a job", intent: "implement" });
    expect(ledger.admit(fp).dispatchCount).toBe(1);
    ledger.recordOutcome(fp, "deadline");
    expect(ledger.admit(fp).dispatchCount).toBe(2);
    ledger.recordOutcome(fp, "deadline");
    expect(ledger.admit(fp).dispatchCount).toBe(3);
  });

  test("dispatch count advances across repeated same-brief admits", () => {
    const ledger = createBriefDispatchLedger();
    const fp = fingerprintTaskBrief({ prompt: "budget job" });
    expect(ledger.admit(fp).dispatchCount).toBe(1);
    ledger.recordOutcome(fp, "deadline");
    const second = ledger.admit(fp);
    expect(second.dispatchCount).toBe(2);
  });

  test("successful complete resets retry budget", () => {
    const ledger = createBriefDispatchLedger();
    const fp = fingerprintTaskBrief({ prompt: "ok job" });
    expect(ledger.admit(fp).dispatchCount).toBe(1);
    ledger.recordOutcome(fp, "deadline");
    expect(ledger.admit(fp).dispatchCount).toBe(2);
    // Success zeros dispatchCount so the next admit is 1.
    ledger.recordOutcome(fp, null);
    const afterSuccess = ledger.admit(fp);
    expect(afterSuccess.dispatchCount).toBe(1);
  });

  test("release undoes admit when run never produces a body", () => {
    const ledger = createBriefDispatchLedger();
    const fp = fingerprintTaskBrief({ prompt: "crash job" });
    expect(ledger.admit(fp).dispatchCount).toBe(1);
    ledger.release(fp);
    const again = ledger.admit(fp);
    expect(again.dispatchCount).toBe(1);
  });

  test("classifyBriefSalvage decides purely from the structured stop reason, never from report prose", () => {
    // classifyBriefSalvage takes no report text at all — only the structured
    // stopReason and an independently-observed wasCancelled flag.
    expect(classifyBriefSalvage({ wasCancelled: false })).toBeNull();
    expect(classifyBriefSalvage({ stopReason: "deadline", wasCancelled: false })).toBe("deadline");
    // An operator cancel wins even when the run's own reason disagrees.
    expect(classifyBriefSalvage({ stopReason: "deadline", wasCancelled: true })).toBe("cancelled");
  });

  test("createTaskTool always re-dispatches an identical brief after a forced-stop salvage", async () => {
    const thrash = {
      report: forcedStopReport("deadline", "Repeated the same call"),
      stopReason: "deadline" as const,
    };
    let runs = 0;
    const sessions = createSubAgentSessionStore();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.corbits",
      provider,
      sessions,
      run: async () => {
        runs += 1;
        return thrash;
      },
    });
    const args = {
      description: "Thrash job",
      prompt: "do the thrashy work",
      intent: "implement",
    };
    const first = await callTask(tool, args);
    expect(first).toContain("deadline");
    expect(runs).toBe(1);
    expect(sessions.list().filter((s) => s.status === "running")).toHaveLength(0);

    // Re-dispatching the identical brief is admitted, not refused.
    const second = await callTask(tool, args);
    expect(second).not.toContain("refused re-dispatch");
    expect(runs).toBe(2);
    expect(sessions.list().filter((s) => s.status === "running")).toHaveLength(0);
    expect(sessions.list().filter((s) => s.description === "Thrash job")).toHaveLength(1);
  });
});
