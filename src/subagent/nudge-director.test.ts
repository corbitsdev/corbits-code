import { describe, expect, test } from "bun:test";
import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ReactorState,
} from "@intx/types/runtime";
import { createCorbitsRetryPolicy } from "../agent/retry-policy.js";
import { COMPACTOR_KEEP_RECENT_TURNS, compactorNoOpFloor } from "../session/compactor.js";
import { SubAgentDirector } from "./nudge-director.js";
import type { AdmissionQueue } from "./admission.js";

const state = { turns: [] } as unknown as ReactorState;
const longState = {
  turns: Array.from({ length: compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS) + 1 }, () => ({
    role: "user",
    content: [],
    timestamp: 0,
  })),
} as unknown as ReactorState;

function capabilities(): ReactorCapabilities {
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
    usage: { input: inputTokens, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

function inferenceDoneText(text: string, inputTokens = 0): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      model: "test",
      timestamp: 0,
      content: [{ type: "text", text }],
    },
    usage: { input: inputTokens, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    source: { model: "test-model" },
  } as unknown as ReactorInboundEvent;
}

function toolDone(callId: string, isError = false): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: isError ? "failed" : "ok", isError },
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
    (action): action is Extract<ReactorAction, { type: "infer" }> => action.type === "infer",
  );
  if (infer === undefined) throw new Error("expected infer action");
  return infer;
}

function overflowError(message = "context window exceeded"): ReactorInboundEvent {
  return {
    type: "inference.error",
    error: { category: "context_overflow", message },
    partial: { text: "" },
  } as unknown as ReactorInboundEvent;
}

function ephemeralTexts(infer: Extract<ReactorAction, { type: "infer" }>): string[] | undefined {
  const options = infer.options as
    { ephemeralTurns?: { content: { text?: string }[] }[] } | undefined;
  return options?.ephemeralTurns?.map((turn) => turn.content[0]?.text ?? "");
}

describe("SubAgentDirector tool failure recovery", () => {
  test("failed tool result adds one actionable ephemeral recovery nudge", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    await director.decide(inferenceDone(["failed-call"]), state, caps);
    const texts = ephemeralTexts(
      inferAction(await director.decide(toolDone("failed-call", true), state, caps)),
    );

    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("Do not repeat the same failed call unchanged");
    expect(texts?.[0]).toContain("Inspect the error and current state");
    expect(texts?.[0]).toContain("change the arguments or approach");
    expect(texts?.[0]).toContain("report the blocker");
  });

  test("successful tool result has no ephemeral recovery turn", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    await director.decide(inferenceDone(["successful-call"]), state, caps);
    const infer = inferAction(await director.decide(toolDone("successful-call"), state, caps));

    expect(ephemeralTexts(infer)).toBeUndefined();
  });

  test("waits for all pending results and carries one recovery nudge on the normal infer", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    await director.decide(inferenceDone(["failed-first", "successful-last"]), state, caps);
    const firstResult = actions(await director.decide(toolDone("failed-first", true), state, caps));
    expect(firstResult.some((action) => action.type === "infer")).toBe(false);

    const texts = ephemeralTexts(
      inferAction(await director.decide(toolDone("successful-last"), state, caps)),
    );
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("A tool call failed");
  });

  test("a later successful cycle has no stale recovery nudge", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    await director.decide(inferenceDone(["failed-cycle"]), state, caps);
    await director.decide(toolDone("failed-cycle", true), state, caps);

    await director.decide(inferenceDone(["later-success"]), state, caps);
    const infer = inferAction(await director.decide(toolDone("later-success"), state, caps));
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
    );
    const caps = capabilities();

    await director.decide(inferenceDone(["failed-at-threshold"], 999_999), longState, caps);
    const compact = actions(
      await director.decide(toolDone("failed-at-threshold", true), longState, caps),
    );
    expect(compact.some((action) => action.type === "infer")).toBe(false);
    expect(compact).toEqual([
      { type: "checkpoint", message: "tool-done" },
      { type: "compact", compactor: "pruning-compactor", reason: "context-threshold" },
    ]);
    expect(continuations).toBe(1);

    const resumed = inferAction(await director.decide(messageReceived(""), longState, caps));
    const resumedTexts = ephemeralTexts(resumed);
    expect(resumedTexts).toHaveLength(1);
    expect(resumedTexts?.[0]).toContain("A tool call failed");

    const later = inferAction(await director.decide(messageReceived(""), longState, caps));
    expect(ephemeralTexts(later)).toBeUndefined();
  });

  test("failed-tool recovery supersedes soft re-read guidance", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();
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
      inferenceDone(callIds, 0, (id) => (id.startsWith("shared-") ? "shared.ts" : `${id}.ts`)),
      state,
      caps,
    );
    for (const callId of callIds.slice(0, -1)) {
      await director.decide(toolDone(callId), state, caps);
    }
    const texts = ephemeralTexts(
      inferAction(await director.decide(toolDone("failed-last", true), state, caps)),
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
    );
    const caps = capabilities();

    await director.decide(inferenceDone(["failed-then-overflow"]), state, caps);
    const texts = ephemeralTexts(
      inferAction(await director.decide(toolDone("failed-then-overflow", true), state, caps)),
    );
    expect(texts).toHaveLength(1);
    expect(texts?.[0]).toContain("A tool call failed");

    const compact = actions(await director.decide(overflowError(), state, caps));
    expect(compact.some((action) => action.type === "infer")).toBe(false);
    expect(compact).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-overflow" },
    ]);
    expect(continuations).toBe(1);

    const resumed = inferAction(await director.decide(messageReceived(""), state, caps));
    const resumedTexts = ephemeralTexts(resumed);
    expect(resumedTexts).toHaveLength(1);
    expect(resumedTexts?.[0]).toContain("A tool call failed");

    const later = inferAction(await director.decide(messageReceived(""), state, caps));
    expect(ephemeralTexts(later)).toBeUndefined();
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
    );
    const caps = capabilities();

    await director.decide(inferenceDone(["failed-then-done"]), state, caps);
    const recovered = ephemeralTexts(
      inferAction(await director.decide(toolDone("failed-then-done", true), state, caps)),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered?.[0]).toContain("A tool call failed");

    await director.decide(inferenceDone(["later-success"]), state, caps);
    const afterSuccess = inferAction(await director.decide(toolDone("later-success"), state, caps));
    expect(ephemeralTexts(afterSuccess)).toBeUndefined();

    const compact = actions(await director.decide(overflowError(), state, caps));
    expect(compact.some((action) => action.type === "infer")).toBe(false);
    expect(compact).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-overflow" },
    ]);
    expect(continuations).toBe(1);

    const resumed = inferAction(await director.decide(messageReceived(""), state, caps));
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

describe("SubAgentDirector incomplete-report wiring", () => {
  test("tool-less narration after tools gets one wrap-up nudge, not a complete", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);

    const result = actions(
      await director.decide(inferenceDoneText("Still looking at the files..."), state, caps),
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
    const caps = capabilities();

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
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText("Still looking at the files..."), state, caps);

    const result = actions(
      await director.decide(inferenceDoneText("Still narrating, no envelope."), state, caps),
    );
    expect(result.some((action) => action.type === "infer")).toBe(false);
    expect(result.some((action) => action.type === "done")).toBe(false);
    expect(result).toContainEqual({ type: "checkpoint", message: "subagent-incomplete-report" });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toContain("narrated instead of writing a report envelope");
    expect(reply.content).toContain("Still narrating, no envelope.");
    expect(reply.content).toContain("## Paths");
    expect(reply.content).toContain("read-1.ts");
  });

  test("tool-less turn with the four headings completes normally", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);

    const result = actions(await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps));
    expect(result.some((action) => action.type === "infer")).toBe(false);
    expect(result).toContainEqual({ type: "checkpoint", message: "subagent-complete" });
    const reply = result.find((action) => action.type === "reply");
    expect(reply).toBeDefined();
    if (reply === undefined || reply.type !== "reply") throw new Error("expected reply action");
    expect(reply.content).toBe(REPORT_ENVELOPE);
    expect(reply.content).not.toContain("narrated instead of writing a report envelope");
  });

  test("zero-tool first turn without a report envelope nudges for one, not a hard stop", async () => {
    const director = new SubAgentDirector("system", [], undefined, 30);
    const caps = capabilities();

    const result = actions(
      await director.decide(inferenceDoneText("I'll write the red tests next"), state, caps),
    );
    expect(result).toContainEqual({
      type: "checkpoint",
      message: "subagent-incomplete-report-nudge",
    });
    expect(result.some((action) => action.type === "reply")).toBe(false);
  });
});

describe("SubAgentDirector post-complete terminalization (CL-7068)", () => {
  test("empty continuation after a valid report reply waits instead of re-inferring", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    const complete = actions(
      await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps),
    );
    expect(complete).toContainEqual({ type: "checkpoint", message: "subagent-complete" });
    expect(complete.some((action) => action.type === "reply")).toBe(true);

    const afterEmpty = actions(await director.decide(messageReceived(""), state, caps));
    expect(afterEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(afterEmpty.some((action) => action.type === "reply")).toBe(false);
    expect(afterEmpty).toContainEqual({ type: "wait" });
  });

  test("stall empty-ping after a report reply does not revive inference", async () => {
    let now = 0;
    const director = new SubAgentDirector("system", [], undefined, 1000, () => now);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    now += 1500;
    const afterStall = actions(await director.decide(messageReceived(""), state, caps));
    expect(afterStall.some((action) => action.type === "infer")).toBe(false);
    expect(afterStall).toContainEqual({ type: "wait" });
    expect(afterStall.some((action) => action.type === "checkpoint")).toBe(false);
  });

  test("a non-empty parent follow-up re-opens inference after a report reply", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    const followup = actions(
      await director.decide(messageReceived("Please also check auth.ts"), state, caps),
    );
    expect(followup.some((action) => action.type === "infer")).toBe(true);
    expect(followup.some((action) => action.type === "wait")).toBe(false);
  });

  test("empty continuation after incomplete-report-stop salvage waits instead of re-inferring", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText("Still looking at the files..."), state, caps);
    const salvage = actions(
      await director.decide(inferenceDoneText("Still narrating, no envelope."), state, caps),
    );
    expect(salvage).toContainEqual({ type: "checkpoint", message: "subagent-incomplete-report" });
    expect(salvage.some((action) => action.type === "reply")).toBe(true);

    const afterEmpty = actions(await director.decide(messageReceived(""), state, caps));
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
    const caps = capabilities();

    // Under-threshold tooling so tool.done does not compact before the report.
    await director.decide(inferenceDone(["read-1"]), longState, caps);
    await director.decide(toolDone("read-1"), longState, caps);

    const complete = actions(
      await director.decide(inferenceDoneText(REPORT_ENVELOPE, 999_999), longState, caps),
    );
    expect(complete).toContainEqual({ type: "checkpoint", message: "subagent-complete" });
    expect(complete.some((action) => action.type === "reply")).toBe(true);
    // noteIdleTurn arms a continuation so the idle-compact path can run.
    expect(continuations).toBe(1);

    const compact = actions(await director.decide(messageReceived(""), longState, caps));
    expect(compact).toEqual([
      { type: "compact", compactor: "pruning-compactor", reason: "context-threshold" },
    ]);
    expect(continuations).toBe(2);

    // Post-compact empty re-entry is meter-only; reportReplied keeps it waiting.
    const afterMeter = actions(await director.decide(messageReceived(""), longState, caps));
    expect(afterMeter.some((action) => action.type === "infer")).toBe(false);
    expect(afterMeter.some((action) => action.type === "reply")).toBe(false);
    expect(afterMeter).toContainEqual({ type: "wait" });
  });

  test("repeated empty continuations after a report reply keep waiting", async () => {
    const director = new SubAgentDirector("system", [], undefined, 1000);
    const caps = capabilities();

    await director.decide(inferenceDone(["read-1"]), state, caps);
    await director.decide(toolDone("read-1"), state, caps);
    await director.decide(inferenceDoneText(REPORT_ENVELOPE), state, caps);

    const firstEmpty = actions(await director.decide(messageReceived(""), state, caps));
    expect(firstEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(firstEmpty).toContainEqual({ type: "wait" });

    const secondEmpty = actions(await director.decide(messageReceived(""), state, caps));
    expect(secondEmpty.some((action) => action.type === "infer")).toBe(false);
    expect(secondEmpty.some((action) => action.type === "reply")).toBe(false);
    expect(secondEmpty).toContainEqual({ type: "wait" });
  });
});

function stubAdmission(notes: { provider: string; until: number }[]): AdmissionQueue {
  return {
    enqueue: () => "running",
    release: () => {},
    setCapacity: () => {},
    notePressure: (provider, untilMs) => {
      notes.push({ provider, until: untilMs });
    },
    cancel: () => {},
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
      retryPolicy,
    );
    const infer = inferAction(await director.decide(messageReceived("go"), state, capabilities()));
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
    expect(notes[0]!.provider).toBe("xai/thegreataxios");

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
