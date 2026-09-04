import { describe, expect, test } from "bun:test";

import {
  buildDispatchBrief,
  createSubAgentRunController,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
  evaluateSubAgentStop,
  forcedStopReport,
  formatSubAgentReport,
  parseSubAgentReport,
  appendSubAgentParentHints,
  EMPTY_THRASH_STATE,
  nextThrashState,
  salvagePathsFromThrash,
  evaluateToolLessNarrationSpiral,
  MAX_TOOLLESS_NARRATION_CYCLES,
  partialTextFromEvent,
  preferCompletedSubAgentReply,
  resolveSubAgentCatchOutcome,
  resolveSubAgentDeadlineMs,
  shouldRequireEvidence,
  subAgentToolName,
  SUBAGENT_DEADLINE_MARGIN_MS,
  SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS,
  SubAgentDirector,
} from "./index.js";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";

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

  test("evaluateToolLessNarrationSpiral nudges once then stops at the cycle cap", () => {
    expect(evaluateToolLessNarrationSpiral(1)).toBe("nudge");
    expect(evaluateToolLessNarrationSpiral(MAX_TOOLLESS_NARRATION_CYCLES)).toBe("stop");
    expect(evaluateToolLessNarrationSpiral(MAX_TOOLLESS_NARRATION_CYCLES + 1)).toBe("stop");
  });

  test("evaluateSubAgentStop spiral uses toolLessNarrationCycles over the deprecated flag", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: SUMMARY_ONLY_NARRATION,
        toolLessNarrationCycles: 1,
        incompleteReportNudgeFired: true,
      }),
    ).toBe("incomplete-report");
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: SUMMARY_ONLY_NARRATION,
        toolLessNarrationCycles: 2,
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

  test("shouldRequireEvidence is armed for the critic director id", () => {
    expect(shouldRequireEvidence({ directorId: "critic" })).toBe(true);
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

  test("re-read pressure no longer stops a worker", () => {
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
    expect(reparsedFields.blockers).toContain("wait for the operator");
    expect(reparsedFields.blockers).not.toContain("parent may re-dispatch");
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
    expect(cancelledParsed.blockers).toContain("wait for the operator");
    expect(cancelledParsed.blockers).not.toContain("parent may re-dispatch");

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
    const cancelledWithHint = appendSubAgentParentHints(
      forcedStopReport("cancelled", "x"),
      "cancelled",
    );
    expect(cancelledWithHint).not.toContain("wall-clock deadline");
    expect(cancelledWithHint).toContain("was cancelled before finishing");
    expect(cancelledWithHint).toContain("Findings and Paths");
    expect(cancelledWithHint).toContain("wait for the operator");
    expect(cancelledWithHint).not.toContain("re-dispatch only if");

    // Paths section carries thrash salvage; empty prose with paths still informs Findings.
    const withPaths = forcedStopReport("cancelled", "", {
      paths: ["src/a.ts", "src/b.ts"],
    });
    const withPathsParsed = parseSubAgentReport(withPaths);
    expect(withPathsParsed.paths).toContain("src/a.ts");
    expect(withPathsParsed.paths).toContain("src/b.ts");
    expect(withPathsParsed.findings).toContain("Files touched before stop");
    expect(withPathsParsed.findings).toContain("src/a.ts");
  });

  test("forcedStopReport renders a Stopped line for display; classification uses the typed reason", () => {
    expect(forcedStopReport("cancelled", "partial", { detail: "Session closed" })).toMatch(
      /^Stopped: cancelled — Session closed\n/,
    );
    expect(forcedStopReport("cancelled", "partial")).toMatch(/^Stopped: cancelled\n/);
    expect(forcedStopReport("deadline", "x", { detail: "30s elapsed" })).toMatch(
      /^Stopped: deadline — 30s elapsed\n/,
    );
    // Nested Stopped: under Findings is display-only; classify via typed reason.
    const nested = forcedStopReport(
      "deadline",
      forcedStopReport("cancelled", "inner", { detail: "inner reason" }),
    );
    expect(nested).toMatch(/^Stopped: deadline\n/);
    expect(nested).toContain("Stopped: cancelled — inner reason");
  });

  test("salvagePathsFromThrash prefers edited paths then collapses chunked reads", () => {
    const state = nextThrashState(EMPTY_THRASH_STATE, [
      {
        type: "tool_call",
        name: "read_file",
        arguments: { path: "src/a.ts", offset: 0, limit: 10 },
      },
      {
        type: "tool_call",
        name: "edit_file",
        arguments: { path: "src/b.ts", old_string: "a", new_string: "b" },
      },
      { type: "tool_call", name: "read_file", arguments: { path: "src/a.ts" } },
    ]);
    expect(salvagePathsFromThrash(state)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(salvagePathsFromThrash(state, 1)).toEqual(["src/b.ts"]);
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

  test("re-reading the same chunk repeatedly is not a stop", () => {
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
