import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { createCorbitsRetryPolicy } from "../agent/retry-policy.js";
import {
  COMPACTOR_KEEP_RECENT_TURNS,
  compactorNoOpFloor,
} from "../session/compactor.js";
import { SubAgentDirector } from "./nudge-director.js";
import type { AdmissionQueue } from "./admission.js";
import { createTestCapabilities } from "./director-test-harness.js";
import { defined } from "../../tests/helpers/defined.js";

const state = { turns: [] } as unknown as ReactorState;
const longState = {
  turns: Array.from(
    { length: compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS) + 1 },
    () => ({
      role: "user",
      content: [],
      timestamp: 0,
    }),
  ),
} as unknown as ReactorState;

// These tests are not about stall timing. With the default real clock, a
// parallel-run load gap over the 30 ms stall window between awaited
// decides would trip a spurious stall nudge on the empty continuation
// pings, so freeze time instead.
const frozenNow = () => 0;

function inferenceDone(
  callIds: string[],
  inputTokens = 0,
  pathForId: (id: string) => string = (id) => `${id}.ts`,
): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: callIds.map((id) => ({
        type: "tool_call",
        id,
        name: "read_file",
        arguments: { path: pathForId(id) },
      })),
    },
    usage: {
      input: inputTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

function inferenceDoneText(text: string, inputTokens = 0): ReactorInboundEvent {
  return inferenceDoneContent([{ type: "text", text }], inputTokens);
}

function inferenceDoneContent(
  content: readonly Record<string, unknown>[],
  inputTokens = 0,
): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content,
    },
    usage: {
      input: inputTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

function toolDone(callId: string, isError = false): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: isError ? "failed" : "ok", isError },
  } as unknown as ReactorInboundEvent;
}

function resumeToolResult(callId: string): ReactorInboundEvent {
  return {
    type: "resume.tool_result",
    result: { callId, content: "denied by approver", isError: true },
  } as unknown as ReactorInboundEvent;
}

function messageReceived(content: string): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { role: "user", content },
  } as unknown as ReactorInboundEvent;
}

function actions(result: ReactorAction | ReactorAction[]): ReactorAction[] {
  return Array.isArray(result) ? result : [result];
}

function inferAction(
  result: ReactorAction | ReactorAction[],
): Extract<ReactorAction, { type: "infer" }> {
  const infer = actions(result).find(
    (action): action is Extract<ReactorAction, { type: "infer" }> =>
      action.type === "infer",
  );
  if (infer === undefined) throw new Error("expected infer action");
  return infer;
}

function overflowError(
  message = "context window exceeded",
): ReactorInboundEvent {
  return {
    type: "inference.error",
    error: { category: "context_overflow", message },
    partial: { text: "" },
  } as unknown as ReactorInboundEvent;
}

function ephemeralTexts(
  infer: Extract<ReactorAction, { type: "infer" }>,
): string[] | undefined {
  const options = infer.options as
    | { ephemeralTurns?: { content: { text?: string }[] }[] }
    | undefined;
  return options?.ephemeralTurns?.map((turn) => turn.content[0]?.text ?? "");
}

describe("SubAgentDirector tool failure recovery", () => {
  test("failed tool result adds one actionable ephemeral recovery nudge", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["failed-call"]), state, caps);
    const texts = ephemeralTexts(
      inferAction(
        await director.decide(toolDone("failed-call", true), state, caps),
      ),
    );

    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain(
      "Do not repeat the same failed call unchanged",
    );
    expect(texts?.[0]).toContain("Inspect the error and current state");
    expect(texts?.[0]).toContain("change the arguments or approach");
    expect(texts?.[0]).toContain("report the blocker");
  });

  test("coalesces consecutive failed tool audits into one counted intervention", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();
    const records: { id: string; count?: number }[] = [];
    director.observeInterventions((event) => {
      records.push(
        event.count === undefined
          ? { id: event.id }
          : { id: event.id, count: event.count },
      );
    });

    await director.decide(
      inferenceDone(["fail-a", "fail-b", "ok-c"]),
      state,
      caps,
    );
    await director.decide(toolDone("fail-a", true), state, caps);
    expect(records).toEqual([]);
    await director.decide(toolDone("fail-b", true), state, caps);
    expect(records).toEqual([]);

    const texts = ephemeralTexts(
      inferAction(await director.decide(toolDone("ok-c"), state, caps)),
    );
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("A tool call failed");
    expect(records).toEqual([{ id: "tool-failure-recovery", count: 2 }]);
  });

  test("a single failed tool audit omits the count field", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();
    const records: { id: string; count: number | null }[] = [];
    director.observeInterventions((event) => {
      records.push({ id: event.id, count: event.count ?? null });
    });

    await director.decide(inferenceDone(["fail-a"]), state, caps);
    await director.decide(toolDone("fail-a", true), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    expect(records).toEqual([{ id: "tool-failure-recovery", count: null }]);
  });

  test("flushes an undelivered recovery burst when the run goes terminal", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();
    const records: { id: string; count?: number }[] = [];
    director.observeInterventions((event) => {
      records.push(
        event.count === undefined
          ? { id: event.id }
          : { id: event.id, count: event.count },
      );
    });

    // ok-c stays pending so the armed recovery nudge never reaches an infer.
    await director.decide(
      inferenceDone(["fail-a", "fail-b", "ok-c"]),
      state,
      caps,
    );
    await director.decide(toolDone("fail-a", true), state, caps);
    await director.decide(toolDone("fail-b", true), state, caps);
    expect(records).toEqual([]);

    const result = actions(
      await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    expect(records).toEqual([{ id: "tool-failure-recovery", count: 2 }]);
  });

  test("successful tool result has no ephemeral recovery turn", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["successful-call"]), state, caps);
    const infer = inferAction(
      await director.decide(toolDone("successful-call"), state, caps),
    );

    expect(ephemeralTexts(infer)).toBeUndefined();
  });

  test("waits for all pending results and carries one recovery nudge on the normal infer", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(
      inferenceDone(["failed-first", "successful-last"]),
      state,
      caps,
    );
    const firstResult = actions(
      await director.decide(toolDone("failed-first", true), state, caps),
    );
    expect(firstResult.some((action) => action.type === "infer")).toBe(false);

    const texts = ephemeralTexts(
      inferAction(
        await director.decide(toolDone("successful-last"), state, caps),
      ),
    );
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("A tool call failed");
  });

  test("a later successful cycle has no stale recovery nudge", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["failed-cycle"]), state, caps);
    await director.decide(toolDone("failed-cycle", true), state, caps);

    await director.decide(inferenceDone(["later-success"]), state, caps);
    const infer = inferAction(
      await director.decide(toolDone("later-success"), state, caps),
    );
    expect(ephemeralTexts(infer)).toBeUndefined();
  });

  test("retains recovery through compaction and consumes it once on continuation infer", async () => {
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      30,
      frozenNow,
    );
    const caps = createTestCapabilities();

    await director.decide(
      inferenceDone(["failed-at-threshold"], 999_999),
      longState,
      caps,
    );
    const compact = actions(
      await director.decide(
        toolDone("failed-at-threshold", true),
        longState,
        caps,
      ),
    );
    expect(compact.some((action) => action.type === "infer")).toBe(false);
    expect(compact).toEqual([
      { type: "checkpoint", message: "tool-done" },
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
    ]);
    expect(continuations).toBe(1);

    const resumed = inferAction(
      await director.decide(messageReceived(""), longState, caps),
    );
    const resumedTexts = ephemeralTexts(resumed);
    expect(resumed.options?.systemPrompt).toBe("system");
    expect(resumedTexts).toHaveLength(1);
    expect(resumedTexts?.[0]).toContain("A tool call failed");

    const later = actions(
      await director.decide(messageReceived(""), longState, caps),
    );
    expect(later).toEqual([{ type: "wait" }]);
    expect(later.some((action) => action.type === "infer")).toBe(false);
  });

  test("recovery nudge appends to ephemeral turns already on the infer", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();
    // Seed an ephemeral turn only when the caller did not supply any, so the
    // infer action applyPendingNudge rewrites already carries ephemeral turns.
    const seeding: ReactorCapabilities = {
      ...caps,
      infer: (options) => {
        const existing = (options as { ephemeralTurns?: unknown[] } | undefined)
          ?.ephemeralTurns;
        return caps.infer({
          ...(options ?? {}),
          ...(existing === undefined
            ? {
                ephemeralTurns: [
                  {
                    role: "user",
                    content: [{ type: "text", text: "PRE-SEEDED-EPHEMERAL" }],
                    timestamp: 0,
                  },
                ],
              }
            : {}),
        });
      },
    };

    await director.decide(inferenceDone(["seeded-fail"]), state, seeding);
    const texts = ephemeralTexts(
      inferAction(
        await director.decide(toolDone("seeded-fail", true), state, seeding),
      ),
    );

    expect(texts).toHaveLength(2);
    expect(texts?.[0]).toBe("PRE-SEEDED-EPHEMERAL");
    expect(texts?.[1]).toContain("A tool call failed");
  });

  test("failed-tool recovery supersedes soft re-read guidance", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();
    const callIds = [
      "shared-1",
      "shared-2",
      "shared-3",
      "unique-1",
      "unique-2",
      "unique-3",
      "unique-4",
      "failed-last",
    ];

    await director.decide(
      inferenceDone(callIds, 0, (id) =>
        id.startsWith("shared-") ? "shared.ts" : `${id}.ts`,
      ),
      state,
      caps,
    );
    for (const callId of callIds.slice(0, -1)) {
      await director.decide(toolDone(callId), state, caps);
    }
    const texts = ephemeralTexts(
      inferAction(
        await director.decide(toolDone("failed-last", true), state, caps),
      ),
    );

    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("A tool call failed");
    expect(texts?.[0]).not.toContain("re-reading the same paths");
  });

  test("overflow after consume restores recovery once on continuation infer", async () => {
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      30,
      frozenNow,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["failed-then-overflow"]), state, caps);
    const texts = ephemeralTexts(
      inferAction(
        await director.decide(
          toolDone("failed-then-overflow", true),
          state,
          caps,
        ),
      ),
    );
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("A tool call failed");

    const compact = actions(
      await director.decide(overflowError(), state, caps),
    );
    expect(compact.some((action) => action.type === "infer")).toBe(false);
    expect(compact).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-overflow",
      },
    ]);
    expect(continuations).toBe(1);

    const resumed = inferAction(
      await director.decide(messageReceived(""), state, caps),
    );
    const resumedTexts = ephemeralTexts(resumed);
    expect(resumed.options?.systemPrompt).toBe("system");
    expect(resumedTexts).toHaveLength(1);
    expect(resumedTexts?.[0]).toContain("A tool call failed");

    const later = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(later).toEqual([{ type: "wait" }]);
    expect(later.some((action) => action.type === "infer")).toBe(false);
  });

  test("successful nudged infer then later overflow does not resurrect recovery", async () => {
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      30,
      frozenNow,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["failed-then-done"]), state, caps);
    const recovered = ephemeralTexts(
      inferAction(
        await director.decide(toolDone("failed-then-done", true), state, caps),
      ),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered?.[0]).toContain("A tool call failed");

    await director.decide(inferenceDone(["later-success"]), state, caps);
    const afterSuccess = inferAction(
      await director.decide(toolDone("later-success"), state, caps),
    );
    expect(ephemeralTexts(afterSuccess)).toBeUndefined();

    const compact = actions(
      await director.decide(overflowError(), state, caps),
    );
    expect(compact.some((action) => action.type === "infer")).toBe(false);
    expect(compact).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-overflow",
      },
    ]);
    expect(continuations).toBe(1);

    const resumed = inferAction(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(resumed.options?.systemPrompt).toBe("system");
    expect(ephemeralTexts(resumed)).toBeUndefined();
  });
});

const REPORT_ENVELOPE = [
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

describe("SubAgentDirector verbatim tool markup recovery", () => {
  const verbatimToolCall =
    '<tool_call><function=read_file>{"path":"src/index.ts"}</function></tool_call>';

  test("nudges once for explicit tool-call wrapper text before report policy", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    const correction = actions(
      await director.decide(inferenceDoneText(verbatimToolCall), state, caps),
    );
    expect(correction).toContainEqual({
      type: "checkpoint",
      message: "subagent-verbatim-tool-call-nudge",
    });
    expect(ephemeralTexts(inferAction(correction))?.[0]).toContain(
      "real tool call",
    );

    const reportNudge = actions(
      await director.decide(inferenceDoneText(verbatimToolCall), state, caps),
    );
    expect(reportNudge).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });

    const stopped = actions(
      await director.decide(inferenceDoneText(verbatimToolCall), state, caps),
    );
    expect(stopped).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report",
    });
  });

  test("does not treat arbitrary XML or thinking as verbatim tool calls", async () => {
    const caps = createTestCapabilities();
    const arbitraryXML = new SubAgentDirector("system", [], undefined, 30);
    const arbitraryResult = actions(
      await arbitraryXML.decide(
        inferenceDoneText("<read_file>src/index.ts</read_file>"),
        state,
        caps,
      ),
    );
    expect(arbitraryResult).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });

    const thinkingOnly = new SubAgentDirector("system", [], undefined, 30);
    const thinkingResult = actions(
      await thinkingOnly.decide(
        inferenceDoneContent([
          { type: "thinking", thinking: verbatimToolCall },
        ]),
        state,
        caps,
      ),
    );
    expect(thinkingResult).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
  });

  test("resets correction only after genuine tool activity or parent follow-up", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText(verbatimToolCall), state, caps);
    const narration = actions(
      await director.decide(inferenceDoneText("Still working"), state, caps),
    );
    expect(narration).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    const afterTool = actions(
      await director.decide(inferenceDoneText(verbatimToolCall), state, caps),
    );
    expect(afterTool).toContainEqual({
      type: "checkpoint",
      message: "subagent-verbatim-tool-call-nudge",
    });

    await director.decide(messageReceived("Try again"), state, caps);
    const afterFollowup = actions(
      await director.decide(inferenceDoneText(verbatimToolCall), state, caps),
    );
    expect(afterFollowup).toContainEqual({
      type: "checkpoint",
      message: "subagent-verbatim-tool-call-nudge",
    });
  });

  test("after the verbatim nudge a real tool call executes", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText(verbatimToolCall), state, caps);
    const result = actions(
      await director.decide(inferenceDone(["read-1"]), state, caps),
    );
    expect(result.some((action) => action.type === "execute_tools")).toBe(true);
    expect(result.some((action) => action.type === "reply")).toBe(false);
  });

  test("after the verbatim nudge a four-heading envelope completes", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText(verbatimToolCall), state, caps);
    const result = actions(
      await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
  });

  test("a complete envelope that quotes tool-call markup still completes", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    const reportQuotingMarkup = `${REPORT_ENVELOPE}\n\nThe model emitted ${verbatimToolCall} as text.`;
    const result = actions(
      await director.decide(
        inferenceDoneText(reportQuotingMarkup),
        state,
        caps,
      ),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    expect(result).not.toContainEqual({
      type: "checkpoint",
      message: "subagent-verbatim-tool-call-nudge",
    });
  });
});

describe("SubAgentDirector incomplete-report wiring", () => {
  test("tool-less narration after tools gets one wrap-up nudge, not a complete", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);

    const result = actions(
      await director.decide(
        inferenceDoneText("Still looking at the files..."),
        state,
        caps,
      ),
    );
    expect(result.some((action) => action.type === "reply")).toBe(false);
    expect(result.some((action) => action.type === "done")).toBe(false);
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
    const texts = ephemeralTexts(inferAction(result));
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("## Summary");
    expect(texts?.[0]).toContain("## Findings");
    expect(texts?.[0]).toContain("## Blockers");
    expect(texts?.[0]).toContain("## Paths");
    expect(texts?.[0]).toContain("No more tools unless one lookup is required");
  });

  test("Summary-only mid-run narration gets a wrap-up nudge, not done", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);

    const result = actions(
      await director.decide(
        inferenceDoneText(
          [
            "## Summary",
            "Checking whether Skywalker write-tool unmount is tested...",
            "Checking those next.",
          ].join("\n"),
        ),
        state,
        caps,
      ),
    );
    expect(result.some((action) => action.type === "reply")).toBe(false);
    expect(result.some((action) => action.type === "done")).toBe(false);
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
    const texts = ephemeralTexts(inferAction(result));
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("## Findings");
    expect(texts?.[0]).toContain("## Blockers");
    expect(texts?.[0]).toContain("## Paths");
  });

  test("second tool-less narration after the wrap-up nudge salvages incomplete-report", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(
      inferenceDoneText("Still looking at the files..."),
      state,
      caps,
    );

    const result = actions(
      await director.decide(
        inferenceDoneText("Still narrating, no envelope."),
        state,
        caps,
      ),
    );
    expect(result.some((action) => action.type === "infer")).toBe(false);
    expect(result.some((action) => action.type === "done")).toBe(false);
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report",
    });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply")
      throw new Error("expected reply action");
    expect(reply.content).toContain(
      "narrated instead of writing a report envelope",
    );
    expect(reply.content).toContain("Still narrating, no envelope.");
    expect(reply.content).toContain("one successor");
    expect(reply.content).toContain("changed brief");
    expect(reply.content).not.toContain("wait for the operator");
    expect(reply.content).toContain("## Paths");
    expect(reply.content).toContain("read-1.ts");
  });

  test("incomplete-report-stop fires once then waits on later tool-less turns", async () => {
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      frozenNow,
    );
    const caps = createTestCapabilities();
    const records: { id: string; class: string }[] = [];
    director.observeInterventions((event) => {
      records.push({ id: event.id, class: event.class });
    });

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(
      inferenceDoneText("Still looking at the files..."),
      state,
      caps,
    );
    const salvage = actions(
      await director.decide(
        inferenceDoneText("Still narrating, no envelope."),
        state,
        caps,
      ),
    );
    expect(salvage).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report",
    });
    expect(
      records.filter(
        (event) =>
          event.id === "incomplete-report-stop" && event.class === "stop",
      ),
    ).toHaveLength(1);

    const afterStop = actions(
      await director.decide(
        inferenceDoneText("Still narrating after salvage."),
        state,
        caps,
      ),
    );
    expect(afterStop).toContainEqual({ type: "wait" });
    expect(afterStop.some((action) => action.type === "reply")).toBe(false);
    expect(afterStop.some((action) => action.type === "infer")).toBe(false);
    expect(
      records.filter(
        (event) =>
          event.id === "incomplete-report-stop" && event.class === "stop",
      ),
    ).toHaveLength(1);
  });

  test("tool-using turns reset the tool-less narration count (CL-7788)", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(
      inferenceDoneText("Still looking at the files..."),
      state,
      caps,
    );
    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDone(["read-2"]), state, caps);
    await director.decide(toolDone("read-2"), state, caps);

    const result = actions(
      await director.decide(
        inferenceDoneText("Still narrating, no envelope."),
        state,
        caps,
      ),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
    expect(result.some((action) => action.type === "reply")).toBe(false);
    expect(result.some((action) => action.type === "infer")).toBe(true);
  });

  test("tool-less turn with the four headings completes normally", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);

    const result = actions(
      await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps),
    );
    expect(result.some((action) => action.type === "infer")).toBe(false);
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply")
      throw new Error("expected reply action");
    expect(reply.content).toBe(REPORT_ENVELOPE);
    expect(reply.content).not.toContain(
      "narrated instead of writing a report envelope",
    );
  });

  test("zero-tool first turn without a report envelope nudges for one, not a hard stop", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = createTestCapabilities();

    const result = actions(
      await director.decide(
        inferenceDoneText("I'll write the red tests next"),
        state,
        caps,
      ),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
    expect(result.some((action) => action.type === "reply")).toBe(false);
  });
});

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

const PASS_PLAN_ENVELOPE = [
  "## Summary",
  "Plan for the salvage gate.",
  "",
  "## Findings",
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
  "",
  "## Blockers",
  "None.",
  "",
  "## Paths",
  "src/subagent/report.ts",
].join("\n");

describe("SubAgentDirector plan-substance wiring", () => {
  test("stub plan Findings with requirePlanSubstance nudges for the five parts, not four headings", async () => {
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      Date.now,
      false,
      true,
    );
    const caps = createTestCapabilities();

    const result = actions(
      await director.decide(inferenceDoneText(STUB_PLAN_ENVELOPE), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
    expect(result.some((action) => action.type === "reply")).toBe(false);
    const texts = ephemeralTexts(inferAction(result));
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("files/paths");
    expect(texts?.[0]).toContain("acceptance criteria");
    expect(texts?.[0]).toContain("non-goals");
    expect(texts?.[0]).toContain("risks");
    expect(texts?.[0]).toContain("ordered steps");
    expect(texts?.[0]).not.toContain(
      "Write your final report now using ## Summary",
    );
  });

  test("second stub plan turn salvages incomplete-report with a stub-plan Findings prefix", async () => {
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      Date.now,
      false,
      true,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText(STUB_PLAN_ENVELOPE), state, caps);

    const result = actions(
      await director.decide(inferenceDoneText(STUB_PLAN_ENVELOPE), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report",
    });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply")
      throw new Error("expected reply action");
    expect(reply.content).toContain("not an attachable plan");
    expect(reply.content).toContain("Plan ready.");
    expect(reply.content).toContain("## Summary");
  });

  test("pass plan fixture with requirePlanSubstance completes", async () => {
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      Date.now,
      false,
      true,
    );
    const caps = createTestCapabilities();

    const result = actions(
      await director.decide(inferenceDoneText(PASS_PLAN_ENVELOPE), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply")
      throw new Error("expected reply action");
    expect(reply.content).toBe(PASS_PLAN_ENVELOPE);
  });

  test("wrap-up plan Findings after real tools completes instead of stub salvage", async () => {
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      frozenNow,
      false,
      true,
    );
    const caps = createTestCapabilities();
    const wrapPlan = [
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

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);

    const result = actions(
      await director.decide(inferenceDoneText(wrapPlan), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply")
      throw new Error("expected reply action");
    expect(reply.content).toBe(wrapPlan);
    expect(reply.content).not.toContain("not an attachable plan");
  });
});

describe("SubAgentDirector post-complete terminalization (CL-7068)", () => {
  test("empty continuation after a valid report reply waits instead of re-inferring", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    const complete = actions(
      await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps),
    );
    expect(complete).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    expect(complete.some((action) => action.type === "reply")).toBe(true);

    const afterEmpty = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(afterEmpty.some((action) => action.type === "reply")).toBe(false);
    expect(afterEmpty).toContainEqual({ type: "wait" });
  });

  test("stall empty-ping after a report reply does not revive inference", async () => {
    let now = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    now += 1500;
    const afterStall = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterStall.some((action) => action.type === "infer")).toBe(false);
    expect(afterStall).toContainEqual({ type: "wait" });
    expect(afterStall.some((action) => action.type === "checkpoint")).toBe(
      false,
    );
  });

  test("a non-empty parent follow-up re-opens inference after a report reply", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    const followup = actions(
      await director.decide(
        messageReceived("Please also check auth.ts"),
        state,
        caps,
      ),
    );
    expect(followup.some((action) => action.type === "infer")).toBe(true);
    expect(followup.some((action) => action.type === "wait")).toBe(false);
  });

  test("empty continuation after incomplete-report-stop salvage waits instead of re-inferring", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(
      inferenceDoneText("Still looking at the files..."),
      state,
      caps,
    );
    const salvage = actions(
      await director.decide(
        inferenceDoneText("Still narrating, no envelope."),
        state,
        caps,
      ),
    );
    expect(salvage).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report",
    });
    expect(salvage.some((action) => action.type === "reply")).toBe(true);

    const afterEmpty = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(afterEmpty.some((action) => action.type === "reply")).toBe(false);
    expect(afterEmpty).toContainEqual({ type: "wait" });
  });

  test("idle-compact meter path after a report reply waits instead of re-inferring", async () => {
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      1000,
    );
    const caps = createTestCapabilities();

    // Under-threshold tooling so tool.done does not compact before the report.
    await director.decide(inferenceDone(["read-1"]), longState, caps);
    await director.decide(toolDone("read-1"), longState, caps);

    const complete = actions(
      await director.decide(
        inferenceDoneText(REPORT_ENVELOPE, 999_999),
        longState,
        caps,
      ),
    );
    expect(complete).toContainEqual({
      type: "checkpoint",
      message: "subagent-complete",
    });
    expect(complete.some((action) => action.type === "reply")).toBe(true);
    // noteIdleTurn arms a continuation so the idle-compact path can run.
    expect(continuations).toBe(1);

    const compact = actions(
      await director.decide(messageReceived(""), longState, caps),
    );
    expect(compact).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
    ]);
    expect(continuations).toBe(2);

    // Post-compact empty re-entry is meter-only; reportReplied keeps it waiting.
    const afterMeter = actions(
      await director.decide(messageReceived(""), longState, caps),
    );
    expect(afterMeter.some((action) => action.type === "infer")).toBe(false);
    expect(afterMeter.some((action) => action.type === "reply")).toBe(false);
    expect(afterMeter).toContainEqual({ type: "wait" });
  });

  test("repeated empty continuations after a report reply keep waiting", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    const firstEmpty = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(firstEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(firstEmpty).toContainEqual({ type: "wait" });

    const secondEmpty = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(secondEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(secondEmpty.some((action) => action.type === "reply")).toBe(false);
    expect(secondEmpty).toContainEqual({ type: "wait" });
  });
});

describe("SubAgentDirector stall nudge grace", () => {
  test("long in-flight tool with no assistant text does not stall-nudge", async () => {
    let now = 4_000_000;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["slow-1"]), state, caps);

    now += 60_000;
    const midTool = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(midTool).toEqual([{ type: "wait" }]);

    await director.decide(toolDone("slow-1"), state, caps);
    now += 1_000;
    const afterTool = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterTool).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
  });

  test("resume.tool_result clears in-flight ids so later silence can stall-nudge", async () => {
    let now = 5_000_000;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["parked-1"]), state, caps);
    now += 60_000;
    expect(
      actions(await director.decide(messageReceived(""), state, caps)),
    ).toEqual([{ type: "wait" }]);

    await director.decide(resumeToolResult("parked-1"), state, caps);
    now += 1_000;
    expect(
      actions(await director.decide(messageReceived(""), state, caps)),
    ).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
  });

  test("two queued empty pings in the same tick nudge then wait, not stop", async () => {
    let now = 3_000_000;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("working"), state, caps);

    now += 1_000;
    const first = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(first).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
    expect(first.some((action) => action.type === "reply")).toBe(false);

    const second = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(second).toEqual([{ type: "wait" }]);
  });

  test("queued pings inside grace wait; stop only after grace with no activity", async () => {
    let now = 1_000_000;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("working"), state, caps);

    now += 1_000;
    const first = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(first).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });

    now += 200;
    const midGrace = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(midGrace).toEqual([{ type: "wait" }]);

    now += 200;
    const stillGrace = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(stillGrace).toEqual([{ type: "wait" }]);

    now += 600;
    const stopped = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(stopped).toContainEqual({
      type: "checkpoint",
      message: "subagent-stalled",
    });
    expect(stopped.some((action) => action.type === "reply")).toBe(true);
  });

  test("tool.done during grace clears stallNudgeAt so a later silence nudges again", async () => {
    let now = 2_000_000;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("working"), state, caps);
    now += 1_000;
    const first = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(first).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });

    now += 100;
    await director.decide(toolDone("read-1"), state, caps);

    now += 1_000;
    const afterActivity = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterActivity).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
    expect(afterActivity.some((action) => action.type === "reply")).toBe(false);
  });
});

describe("SubAgentDirector ask_director park wait-guard", () => {
  test("empty stall ping during a parked ask waits instead of inferring", async () => {
    let now = 6_000_000;
    let parked = true;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    director.observeAskPending(() => parked);
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("which file?"), state, caps);
    now += 60_000;
    const parkedPing = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(parkedPing).toEqual([{ type: "wait" }]);
    expect(parkedPing.some((action) => action.type === "infer")).toBe(false);
    expect(parkedPing.some((action) => action.type === "checkpoint")).toBe(
      false,
    );
  });

  test("compact continue skipped during park still resumes infer after unpark", async () => {
    let parked = false;
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      30,
      frozenNow,
    );
    director.observeAskPending(() => parked);
    const caps = createTestCapabilities();

    const compact = actions(
      await director.decide(overflowError(), state, caps),
    );
    expect(compact).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-overflow",
      },
    ]);
    expect(continuations).toBe(1);

    parked = true;
    const duringPark = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(duringPark).toEqual([{ type: "wait" }]);
    expect(duringPark.some((action) => action.type === "infer")).toBe(false);

    parked = false;
    const afterUnpark = inferAction(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterUnpark.type).toBe("infer");
  });

  test("unparked silence past the stall window still stall-nudges", async () => {
    let now = 7_000_000;
    let parked = true;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    director.observeAskPending(() => parked);
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("which file?"), state, caps);
    now += 60_000;
    expect(
      actions(await director.decide(messageReceived(""), state, caps)),
    ).toEqual([{ type: "wait" }]);

    parked = false;
    now += 1_000;
    const afterUnpark = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(afterUnpark).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
    expect(afterUnpark.some((action) => action.type === "infer")).toBe(true);
  });
});

describe("SubAgentDirector idle stall ping", () => {
  const STALL_NUDGE_TEXT =
    "No activity has been observed for a while. If you are waiting on a " +
    "background command, check its status now; otherwise continue working or " +
    "write your report.";

  test("empty ping inside the stall window waits and does not infer", async () => {
    let now = 8_000_000;
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      1_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("working"), state, caps);

    now += 200;
    const early = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(early).toEqual([{ type: "wait" }]);
    expect(early.some((action) => action.type === "infer")).toBe(false);
    expect(early.some((action) => action.type === "checkpoint")).toBe(false);

    // The in-window wait must not restart the silence clock. One stall
    // timeout from the original activity still nudges, once.
    now = 8_000_000 + 1_000;
    const nudge = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(nudge).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
    expect(ephemeralTexts(inferAction(nudge))).toEqual([STALL_NUDGE_TEXT]);

    now += 200;
    const grace = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(grace).toEqual([{ type: "wait" }]);

    now += 800;
    const stopped = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(stopped).toContainEqual({
      type: "checkpoint",
      message: "subagent-stalled",
    });
    expect(stopped.some((action) => action.type === "infer")).toBe(false);
    expect(stopped.some((action) => action.type === "reply")).toBe(true);
  });

  test("outstanding post-compact infer still infers on an in-window empty ping", async () => {
    let now = 9_000_000;
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      60_000,
      () => now,
    );
    const caps = createTestCapabilities();

    const compact = actions(
      await director.decide(overflowError(), state, caps),
    );
    expect(compact).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-overflow",
      },
    ]);
    expect(continuations).toBe(1);

    now += 200;
    const resumed = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(resumed.some((action) => action.type === "infer")).toBe(true);
    expect(resumed.some((action) => action.type === "wait")).toBe(false);
  });

  test("idle-threshold fold still compacts on an in-window empty ping", async () => {
    let now = 10_000_000;
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      60_000,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDone(["read-1"]), longState, caps);
    await director.decide(toolDone("read-1"), longState, caps);
    const complete = actions(
      await director.decide(
        inferenceDoneText(REPORT_ENVELOPE, 999_999),
        longState,
        caps,
      ),
    );
    expect(complete.some((action) => action.type === "reply")).toBe(true);
    expect(continuations).toBe(1);

    now += 200;
    const folded = actions(
      await director.decide(messageReceived(""), longState, caps),
    );
    expect(folded).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
    ]);
    expect(continuations).toBe(2);
    expect(folded.some((action) => action.type === "infer")).toBe(false);
    expect(folded.some((action) => action.type === "wait")).toBe(false);
  });

  test("cache expiry does not fold on an in-window empty ping", async () => {
    // test-model used to take the 10-minute default TTL. Cache expiry is now
    // a prompt transform, not a fold: the in-window ping waits, and the stall
    // nudge still fires off the original activity clock.
    const activityAt = 11_000_000;
    const cacheTtlMs = 10 * 60_000;
    const stallTimeoutMs = 15 * 60_000;
    let now = activityAt;
    let continuations = 0;
    const director = new SubAgentDirector(
      "system",
      [],
      () => {
        continuations++;
      },
      stallTimeoutMs,
      () => now,
    );
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("working"), longState, caps);

    now += cacheTtlMs + 1;
    const ping = actions(
      await director.decide(messageReceived(""), longState, caps),
    );
    expect(ping).toEqual([{ type: "wait" }]);
    expect(continuations).toBe(0);
    expect(ping.some((action) => action.type === "infer")).toBe(false);
    expect(ping.some((action) => action.type === "compact")).toBe(false);

    // The wait must not stamp lastActivityAt or clear stallNudgeAt. One
    // stall timeout from the original activity still nudges, once.
    now = activityAt + stallTimeoutMs;
    const nudge = actions(
      await director.decide(messageReceived(""), longState, caps),
    );
    expect(nudge).toContainEqual({
      type: "checkpoint",
      message: "subagent-stall-nudge",
    });
    expect(ephemeralTexts(inferAction(nudge))).toEqual([STALL_NUDGE_TEXT]);
    expect(nudge.some((action) => action.type === "wait")).toBe(false);
  });

  test("no stall timeout waits on an unsolicited empty continuation", async () => {
    const director = new SubAgentDirector("system", [], undefined);
    const caps = createTestCapabilities();

    await director.decide(inferenceDoneText("working"), state, caps);
    const ping = actions(
      await director.decide(messageReceived(""), state, caps),
    );
    expect(ping).toEqual([{ type: "wait" }]);
    expect(ping.some((action) => action.type === "infer")).toBe(false);
    expect(ping.some((action) => action.type === "checkpoint")).toBe(false);
  });
});

function stubAdmission(
  notes: { provider: string; until: number }[],
): AdmissionQueue {
  return {
    enqueue: () => "running",
    release: () => undefined,
    setCapacity: () => undefined,
    notePressure: (provider, untilMs) => {
      notes.push({ provider, until: untilMs });
    },
    cancel: () => undefined,
    occupied: () => false,
  };
}

describe("SubAgentDirector infer retryPolicy", () => {
  test("infer carries createCorbitsRetryPolicy; retryable 429 notes pressure, quota_exhausted does not", async () => {
    const notes: { provider: string; until: number }[] = [];
    const retryPolicy = createCorbitsRetryPolicy({
      providerId: "xai/thegreataxios",
      admission: stubAdmission(notes),
    });
    const director = new SubAgentDirector(
      "system",
      [],
      undefined,
      30,
      Date.now,
      false,
      false,
      retryPolicy,
    );
    const infer = inferAction(
      await director.decide(
        messageReceived("go"),
        state,
        createTestCapabilities(),
      ),
    );
    const stamped = infer.options?.retryPolicy;
    expect(stamped).toBeDefined();
    if (stamped === undefined) throw new Error("expected infer retryPolicy");

    await stamped({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "retryable",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 2_000,
      },
    });
    expect(notes).toHaveLength(1);
    expect(defined(notes[0]).provider).toBe("xai/thegreataxios");

    notes.length = 0;
    await stamped({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "Too Many Requests",
        statusCode: 429,
        retryAfterMs: 45_000,
        raw: { error: { message: "Too Many Requests" } },
      },
    });
    // xAI remaps this bare 429 to retryable — still notes pressure.
    expect(notes).toHaveLength(1);

    notes.length = 0;
    await stamped({
      attempt: 1,
      elapsedMs: 0,
      error: {
        category: "quota_exhausted",
        message: "monthly cap",
        retryAfterMs: 86_400_000,
      },
    });
    expect(notes).toHaveLength(0);
  });
});
