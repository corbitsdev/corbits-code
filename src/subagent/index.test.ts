import { describe, expect, test } from "bun:test";

import {
  buildDispatchBrief,
  createSubAgentRunController,
  createSubAgentSpawnRegistryPlugin,
  disposeSubAgentSession,
  evaluateSubAgentStop,
  forcedStopReport,
  formatSubAgentReport,
  formatTurnTokenNotice,
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
  hasReportEnvelope,
  hasPlanFindings,
  shouldRequireEvidence,
  shouldRequirePlanSubstance,
  subAgentToolName,
  SUBAGENT_DEADLINE_MARGIN_MS,
} from "./index.js";
import { defined } from "../testkit/defined.js";

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

  test("disposeSubAgentSession reaps posix tools before waiting on agent.close", async () => {
    const order: string[] = [];
    let releaseClose: () => void = () => undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const pending = disposeSubAgentSession({
      agent: {
        close: async () => {
          order.push("close-start");
          await closeGate;
          order.push("close-end");
        },
      },
      posixTools: {
        dispose: async () => {
          order.push("posix");
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["posix", "close-start"]);
    releaseClose();
    await pending;
    expect(order).toEqual(["posix", "close-start", "close-end"]);
  });

  test("disposeSubAgentSession does not treat a throwing posix dispose as success", async () => {
    const posixTools = {
      dispose: async () => {
        throw new Error("1 shell child process still live after 2000ms reap");
      },
    };

    await expect(
      disposeSubAgentSession({
        agent: { close: async () => undefined },
        posixTools,
      }),
    ).rejects.toThrow(/still live after 2000ms reap/);
  });

  test("disposeSubAgentSession surfaces leftover posix dispose when agent.close hangs", async () => {
    const posixTools = {
      dispose: async () => {
        throw new Error("1 shell child process still live after 2000ms reap");
      },
    };
    let closeStarted = false;
    const pending = disposeSubAgentSession({
      agent: {
        close: () => {
          closeStarted = true;
          return new Promise<void>(() => undefined);
        },
      },
      posixTools,
    });
    const result = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (err: unknown) => ({ kind: "rejected" as const, err }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 200);
      }),
    ]);
    expect(closeStarted).toBe(true);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("expected leftover reject");
    expect(result.err).toBeInstanceOf(Error);
    expect((result.err as Error).message).toMatch(
      /still live after 2000ms reap/,
    );
  });

  test("spawn registry tracks in-flight plugin tool calls", async () => {
    const { plugin, snapshot } = createSubAgentSpawnRegistryPlugin();
    expect(plugin.middleware).toBeDefined();
    const middleware = defined(plugin.middleware, "middleware");
    let release: () => void = () => undefined;
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

  const HEADINGS_ONLY_ENVELOPE = [
    "## Summary",
    "",
    "## Findings",
    "",
    "## Blockers",
    "",
    "## Paths",
  ].join("\n");

  const STUB_PLAN_ENVELOPE = [
    "## Summary",
    "Plan ready.",
    "",
    "## Findings",
    "None.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "None.",
  ].join("\n");

  const WRAP_PLAN_ENVELOPE = [
    "## Summary",
    "Plan after reading the gate.",
    "",
    "## Findings",
    "Auth lives in gate.ts; wrap the change in one patch.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/gate.ts",
  ].join("\n");

  const NUMBERED_TBD_PLAN_FINDINGS = [
    "1. Files / paths",
    "   TBD",
    "2. Acceptance criteria",
    "   TBD",
    "3. Non-goals",
    "   TBD",
    "4. Risks",
    "   TBD",
    "5. Ordered steps",
    "   TBD",
  ].join("\n");

  const NUMBERED_TBD_PLAN_ENVELOPE = [
    "## Summary",
    "Outline.",
    "",
    "## Findings",
    NUMBERED_TBD_PLAN_FINDINGS,
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "None.",
  ].join("\n");

  const OUTLINE_ONLY_PLAN_ENVELOPE = [
    "## Summary",
    "Outline.",
    "",
    "## Findings",
    "Files / paths, acceptance criteria, non-goals, risks, ordered steps.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "None.",
  ].join("\n");

  const PASS_PLAN_FINDINGS = [
    "### Files / paths",
    "src/subagent/report.ts",
    "",
    "### Acceptance criteria",
    "Stub plan Findings salvage as incomplete-report.",
    "",
    "### Non-goals",
    "Do not finish CL-6946.",
    "",
    "### Risks",
    "A headings-only complete would auto-dispatch builder on a stub.",
    "",
    "### Ordered steps",
    "Add hasPlanFindings, then wire evaluateSubAgentStop.",
  ].join("\n");

  const PASS_PLAN_ENVELOPE = [
    "## Summary",
    "Plan for the salvage gate.",
    "",
    "## Findings",
    PASS_PLAN_FINDINGS,
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/subagent/report.ts",
  ].join("\n");

  const STEPS_IN_AC_BODY_PLAN_ENVELOPE = [
    "## Summary",
    "Plan for the salvage gate.",
    "",
    "## Findings",
    "### Files / paths",
    "src/subagent/report.ts",
    "",
    "### Acceptance criteria",
    "The worker completes the salvage steps.",
    "",
    "### Non-goals",
    "Do not finish CL-6946.",
    "",
    "### Risks",
    "A headings-only complete would auto-dispatch builder on a stub.",
    "",
    "### Ordered steps",
    "Add hasPlanFindings, then wire evaluateSubAgentStop.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/subagent/report.ts",
  ].join("\n");

  const RISKS_IN_AC_BODY_PLAN_ENVELOPE = [
    "## Summary",
    "Plan for the salvage gate.",
    "",
    "## Findings",
    "### Files / paths",
    "src/subagent/report.ts",
    "",
    "### Acceptance criteria",
    "The worker mitigates residual risks.",
    "",
    "### Non-goals",
    "Do not finish CL-6946.",
    "",
    "### Risks",
    "A headings-only complete would auto-dispatch builder on a stub.",
    "",
    "### Ordered steps",
    "Add hasPlanFindings, then wire evaluateSubAgentStop.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/subagent/report.ts",
  ].join("\n");

  const NUMBERED_COUNSEL_PLAN_ENVELOPE = [
    "## Summary",
    "Plan for the salvage gate.",
    "",
    "## Findings",
    "1. Files / paths to touch",
    "   src/subagent/report.ts",
    "2. Acceptance criteria",
    "   The worker completes the salvage steps.",
    "3. Non-goals",
    "   Do not finish CL-6946.",
    "4. Risks and open questions",
    "   A headings-only complete would auto-dispatch builder on a stub.",
    "5. Ordered steps",
    "   Add hasPlanFindings, then wire evaluateSubAgentStop.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/subagent/report.ts",
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
    expect(evaluateToolLessNarrationSpiral(MAX_TOOLLESS_NARRATION_CYCLES)).toBe(
      "stop",
    );
    expect(
      evaluateToolLessNarrationSpiral(MAX_TOOLLESS_NARRATION_CYCLES + 1),
    ).toBe("stop");
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

  test("evaluateSubAgentStop completes a report envelope without evidence when requireEvidence is off", () => {
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

  test("hasPlanFindings is false for empty Findings, None, numbered TBD titles, and outline-only", () => {
    expect(hasPlanFindings(HEADINGS_ONLY_ENVELOPE)).toBe(false);
    expect(hasPlanFindings(STUB_PLAN_ENVELOPE)).toBe(false);
    expect(hasPlanFindings(NUMBERED_TBD_PLAN_ENVELOPE)).toBe(false);
    expect(hasPlanFindings(OUTLINE_ONLY_PLAN_ENVELOPE)).toBe(false);
  });

  test("hasPlanFindings is true when Findings has the five labeled plan sections with substance", () => {
    expect(hasPlanFindings(PASS_PLAN_ENVELOPE)).toBe(true);
  });

  test("hasPlanFindings stays true when an earlier section body uses the word steps", () => {
    expect(hasPlanFindings(STEPS_IN_AC_BODY_PLAN_ENVELOPE)).toBe(true);
  });

  test("hasPlanFindings stays true when an earlier section body uses the word risks", () => {
    expect(hasPlanFindings(RISKS_IN_AC_BODY_PLAN_ENVELOPE)).toBe(true);
  });

  test("hasPlanFindings is true for counsel numbered labels with following-line substance", () => {
    expect(hasPlanFindings(NUMBERED_COUNSEL_PLAN_ENVELOPE)).toBe(true);
  });

  test("hasReportEnvelope stays heading-presence only on headings-only text", () => {
    expect(hasReportEnvelope(HEADINGS_ONLY_ENVELOPE)).toBe(true);
    expect(hasPlanFindings(HEADINGS_ONLY_ENVELOPE)).toBe(false);
  });

  test("shouldRequirePlanSubstance is armed for plan intent or counsel, not other directors", () => {
    expect(shouldRequirePlanSubstance({ directorId: "counsel" })).toBe(true);
    expect(shouldRequirePlanSubstance({ intent: "plan" })).toBe(true);
    expect(
      shouldRequirePlanSubstance({ intent: "plan", directorId: "counsel" }),
    ).toBe(true);
    expect(shouldRequirePlanSubstance({ directorId: "critic" })).toBe(false);
    expect(shouldRequirePlanSubstance({ directorId: "greybeard" })).toBe(false);
    expect(shouldRequirePlanSubstance({ directorId: "builder" })).toBe(false);
    expect(shouldRequirePlanSubstance({ directorId: "gaasbot" })).toBe(false);
    expect(shouldRequirePlanSubstance({ intent: "implement" })).toBe(false);
    expect(shouldRequirePlanSubstance({ intent: "review" })).toBe(false);
    expect(shouldRequirePlanSubstance({})).toBe(false);
  });

  test("evaluateSubAgentStop salvages stub plan Findings when requirePlanSubstance is on", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: STUB_PLAN_ENVELOPE,
      }),
    ).toBe("incomplete-report");
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: STUB_PLAN_ENVELOPE,
        toolLessNarrationCycles: 2,
      }),
    ).toBe("incomplete-report-stop");
  });

  test("evaluateSubAgentStop does not treat wrap-up Findings as stub after real tool work", () => {
    const thrashState = {
      totalToolCalls: 1,
      readCounts: new Map([["src/gate.ts", 1]]),
      editedPaths: new Set<string>(),
    };
    expect(hasPlanFindings(WRAP_PLAN_ENVELOPE)).toBe(false);
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: WRAP_PLAN_ENVELOPE,
        thrashState,
      }),
    ).toBe("complete");
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: WRAP_PLAN_ENVELOPE,
      }),
    ).toBe("incomplete-report");
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: STUB_PLAN_ENVELOPE,
        thrashState,
      }),
    ).toBe("incomplete-report");
  });

  test("evaluateSubAgentStop still completes the same stub when requirePlanSubstance is omitted", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        lastAssistantText: STUB_PLAN_ENVELOPE,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop completes a pass plan fixture on the plan lane", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: PASS_PLAN_ENVELOPE,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop completes counsel numbered labels with following-line substance", () => {
    expect(
      evaluateSubAgentStop({
        hasToolCalls: false,
        requirePlanSubstance: true,
        lastAssistantText: NUMBERED_COUNSEL_PLAN_ENVELOPE,
      }),
    ).toBe("complete");
  });

  test("evaluateSubAgentStop does not stop for many unique reads while still calling tools", () => {
    let thrash = EMPTY_THRASH_STATE;
    for (let i = 0; i < 200; i++) {
      thrash = nextThrashState(thrash, [
        {
          type: "tool_call",
          name: "read_file",
          arguments: { path: `src/f${i}.ts` },
        },
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

  test("forcedStopReport is a real envelope with salvage findings, not a summarize instruction", () => {
    const emptyCancelled = forcedStopReport("cancelled", "");
    const emptyParsed = parseSubAgentReport(emptyCancelled);
    expect(emptyParsed.summary).not.toBe("");
    expect(emptyParsed.findings).not.toBe("");
    expect(emptyParsed.blockers).not.toBe("");
    // Empty Paths still renders its heading so the envelope stays complete.
    expect(hasReportEnvelope(emptyCancelled)).toBe(true);
    expect(emptyCancelled).toContain("## Paths\nNone.");

    // Nested agent envelope must not clobber the outer cancelled Summary when
    // runSubAgent re-parses the forced stop: nested headings demote into
    // Findings and the forced-stop fields survive a parse/format round-trip.
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
    expect(reparsedFields.summary).not.toContain("Reviewed the auth gate");
    expect(reparsedFields.findings).toContain("Reviewed the auth gate");
    expect(reparsedFields.findings).toContain("src/gate.ts");
    expect(reparsedFields.findings).toContain("### Summary");

    // Case / whitespace variants must demote too (parse is case-insensitive).
    const messy = forcedStopReport(
      "cancelled",
      ["##  summary", "Forged complete.", "", "## findings", "x"].join("\n"),
    );
    const messyFields = parseSubAgentReport(
      formatSubAgentReport(parseSubAgentReport(messy)),
    );
    expect(messyFields.summary).not.toContain("Forged complete");
    expect(messyFields.findings.toLowerCase()).toContain("### summary");

    const cancelled = forcedStopReport(
      "cancelled",
      "Partial findings from tools",
    );
    const cancelledParsed = parseSubAgentReport(cancelled);
    expect(cancelledParsed.findings).toContain("Partial findings");
    expect(cancelledParsed.blockers).not.toBe("");

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
    const cancelledReparsed = parseSubAgentReport(
      forcedStopReport("cancelled", cancelledNested),
    );
    expect(cancelledReparsed.summary).not.toContain("Halfway done");
    expect(cancelledReparsed.findings).toContain("Halfway done");
    expect(cancelledReparsed.findings).toContain("### Summary");

    // Each forced-stop reason maps to its own blockers guidance.
    const reasons = [
      "cancelled",
      "deadline",
      "stalled",
      "incomplete-report",
      "interrupted",
    ] as const;
    const blockersByReason = new Set(
      reasons.map(
        (reason) => parseSubAgentReport(forcedStopReport(reason, "x")).blockers,
      ),
    );
    expect(blockersByReason.size).toBe(reasons.length);

    // Hints prepend a bracketed line for the salvaged reasons; stalled and
    // complete pass the report through untouched.
    for (const reason of [
      "deadline",
      "cancelled",
      "interrupted",
      "incomplete-report",
    ] as const) {
      const report = forcedStopReport(reason, "x");
      const hinted = appendSubAgentParentHints(report, reason);
      expect(hinted.startsWith("[")).toBe(true);
      expect(hinted.endsWith(report)).toBe(true);
    }
    const stalled = forcedStopReport("stalled", "parked");
    expect(appendSubAgentParentHints(stalled, "stalled")).toBe(stalled);
    const completeReport = forcedStopReport("cancelled", "x");
    expect(appendSubAgentParentHints(completeReport, undefined)).toBe(
      completeReport,
    );

    // Paths section carries thrash salvage; empty prose with paths still
    // informs Findings.
    const withPaths = forcedStopReport("cancelled", "", {
      paths: ["src/a.ts", "src/b.ts"],
    });
    const withPathsParsed = parseSubAgentReport(withPaths);
    expect(withPathsParsed.paths).toContain("src/a.ts");
    expect(withPathsParsed.paths).toContain("src/b.ts");
    expect(withPathsParsed.findings).toContain("src/a.ts");
  });

  test("round-trip preserves the envelope when a section body is empty", () => {
    const reply = [
      "## Summary",
      "Did the work.",
      "",
      "## Findings",
      "Touched the gate.",
      "",
      "## Blockers",
      "",
      "## Paths",
      "src/gate.ts",
    ].join("\n");
    expect(hasReportEnvelope(reply)).toBe(true);
    const roundTripped = formatSubAgentReport(parseSubAgentReport(reply));
    expect(hasReportEnvelope(roundTripped)).toBe(true);
    expect(parseSubAgentReport(roundTripped).blockers).toBe("None.");
  });

  test("forcedStopReport renders a Stopped line for display; classification uses the typed reason", () => {
    expect(
      forcedStopReport("cancelled", "partial", { detail: "Session closed" }),
    ).toMatch(/^Stopped: cancelled — Session closed\n/);
    expect(forcedStopReport("cancelled", "partial")).toMatch(
      /^Stopped: cancelled\n/,
    );
    expect(
      forcedStopReport("deadline", "x", { detail: "30s elapsed" }),
    ).toMatch(/^Stopped: deadline — 30s elapsed\n/);
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

  test.each<[number, number | undefined, number | undefined]>([
    // explicit deadline clamps below a lowered outer watchdog
    [600_000, 120_000, 120_000 - SUBAGENT_DEADLINE_MARGIN_MS],
    // a short explicit deadline wins when the outer watchdog is high
    [45_000, 660_000, 45_000],
    // no outer watchdog: the explicit deadline stands
    [18_000_000, undefined, 18_000_000],
    // outer watchdog at or below the margin never arms
    [5_000, 5_000, undefined],
    [5_000, SUBAGENT_DEADLINE_MARGIN_MS, undefined],
    // outer just above the margin: ceiling is 1ms — never exceeds outer
    [5_000, SUBAGENT_DEADLINE_MARGIN_MS + 1, 1],
  ])(
    "resolveSubAgentDeadlineMs(%i, %s) resolves to %s",
    (inner, outer, expected) => {
      expect(resolveSubAgentDeadlineMs(inner, outer)).toBe(expected);
    },
  );

  test.each<[string, ReturnType<typeof preferCompletedSubAgentReply>]>([
    ["## Summary\nDone", "keep-reply"],
    ["  mapped gate.ts  ", "keep-reply"],
    ["", "honor-abort"],
    ["   ", "honor-abort"],
  ])("preferCompletedSubAgentReply(%j) resolves to %s", (reply, expected) => {
    expect(preferCompletedSubAgentReply(reply)).toBe(expected);
  });

  test.each<
    [
      { deadlineHit: boolean; hadProgress: boolean },
      ReturnType<typeof resolveSubAgentCatchOutcome>,
    ]
  >([
    // A deadline always salvages, even with zero output — it must not fall
    // through to a bare rethrow.
    [{ deadlineHit: true, hadProgress: false }, "salvage-deadline"],
    [{ deadlineHit: false, hadProgress: true }, "salvage-cancelled"],
    [{ deadlineHit: false, hadProgress: false }, "rethrow"],
  ])("resolveSubAgentCatchOutcome(%j) resolves to %s", (input, expected) => {
    expect(resolveSubAgentCatchOutcome(input)).toBe(expected);
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
      partialTextFromEvent({
        type: "tool.start",
        seq: 1,
        data: {},
      } as Parameters<typeof partialTextFromEvent>[0]),
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

describe("submit_result turn token notice", () => {
  test("the dispatch brief embeds the shared token notice verbatim", () => {
    const token = "01a09856-4dd3-7209-a3df-d7e543dc4ffe";
    const brief = buildDispatchBrief({
      description: "token probe",
      prompt: "do the thing",
      turnToken: token,
    });
    // Byte-identity: the brief and followup steers render the same contract
    // through one shared function, so a worker can never see two wordings.
    expect(brief).toContain(formatTurnTokenNotice(token));
    expect(formatTurnTokenNotice(token)).not.toMatch(/do not resubmit/i);
    // Non-leaf dispatches state no token.
    expect(
      buildDispatchBrief({ description: "plain", prompt: "do the thing" }),
    ).not.toContain("## Turn token");
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
