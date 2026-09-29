import { describe, expect, test } from "bun:test";
import type {
  ConversationTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  TokenUsage,
} from "@intx/types/runtime";
import {
  COMPACTION_CONTINUATION_EVENT,
  OPERATOR_COMPACT_REASON,
  createCompactionGovernor,
  foldNonConvergedNotice,
  stickyExtraInstructionsFromRecords,
} from "./compaction.js";
import {
  COMPACTION_FOLD_NONCONVERGED_EVENT,
  createChatDirector,
} from "./director.js";
import {
  compactionWideResumeDeltaFor,
  compactionThresholdFor,
} from "../provider/context-window.js";
import {
  COMPACT_SPACER_TEXT,
  LEGACY_COMPACT_SPACER_TEXT,
  compactorNoOpFloor,
} from "../session/compactor.js";
import { buildSummaryPrompt } from "../session/summarizer.js";

const capabilities = {
  infer: (options?: unknown) => ({
    type: "infer",
    ...(options !== undefined ? { options } : {}),
  }),
  compact: (compactor: string, reason: string) => ({
    type: "compact",
    compactor,
    reason,
  }),
  emit: (eventType: string, data: unknown) => ({
    type: "emit",
    eventType,
    data,
  }),
} as unknown as ReactorCapabilities;

// Distinct, non-zero cacheRead/cacheWrite so a test asserting on the total
// would fail if compaction.ts ever stopped routing through the shared
// contextTokensFromUsage and summed only `input` again.
function usage(input: number): TokenUsage {
  return { input, output: 0, cacheRead: 3, cacheWrite: 5, thinking: 0 };
}

// A provider that truly omits usage reports every field as zero, not just
// `input` — distinct from usage(0), which still carries the fixture's
// non-zero cache values above.
function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function turnsOfLength(count: number, textLength: number): ConversationTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: "x".repeat(textLength) }],
    timestamp: i,
  })) as unknown as ConversationTurn[];
}

function inferenceDone(
  input: number,
  text = "",
  provider = "p",
): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: text.length > 0 ? [{ type: "text", text }] : [],
    },
    usage: usage(input),
    source: { sourceId: "s", provider, model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function inferenceDoneWithTools(
  input: number,
): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "c1",
          name: "read_file",
          arguments: { path: "a.ts" },
        },
      ],
    },
    usage: usage(input),
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function inferenceDoneWithoutUsage(): Extract<
  ReactorInboundEvent,
  { type: "inference.done" }
> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    usage: zeroUsage(),
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function inferenceDoneMissingUsage(): Extract<
  ReactorInboundEvent,
  { type: "inference.done" }
> {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    source: { sourceId: "s", provider: "p", model: "m" },
  } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
}

function toolDone(): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId: "c1", content: "ok" },
  } as ReactorInboundEvent;
}

function emptyMessage(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { content: "" },
  } as ReactorInboundEvent;
}

function overflowError(): ReactorInboundEvent {
  return {
    type: "inference.error",
    error: { category: "context_overflow", message: "too big" },
    partial: { text: "" },
  } as ReactorInboundEvent;
}

const overThreshold = compactionThresholdFor("m") + 1;
const wideDelta = compactionWideResumeDeltaFor("m");
const inferAction: ReactorAction[] = [{ type: "infer" }];
const tenTurns = turnsOfLength(10, 1);

describe("compaction governor", () => {
  test("stays inert below the threshold or with few turns", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    governor.noteInferenceDone(
      inferenceDone(overThreshold),
      turnsOfLength(1, 1),
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("disarms a sticky pending when a later measurement falls under threshold", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    // Under-threshold follow-up must clear pending, not leave it armed.
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("expresses continuation as an emit action without a closure", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
    expect(actions?.some((a) => a.type === "infer")).toBe(false);
    expect(
      actions?.some(
        (a) =>
          a.type === "emit" &&
          "eventType" in a &&
          a.eventType === COMPACTION_CONTINUATION_EVENT,
      ),
    ).toBe(true);
    expect(
      governor
        .interceptOverflow(overflowError(), capabilities)
        ?.some(
          (a) =>
            a.type === "emit" &&
            "eventType" in a &&
            a.eventType === COMPACTION_CONTINUATION_EVENT,
        ),
    ).toBe(true);
  });

  test("an idle over-threshold turn requests a continuation and compacts on its arrival", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);

    const terminal: ReactorAction[] = [{ type: "reply", content: "done" }];
    governor.noteIdleTurn(inferenceDone(overThreshold), terminal);
    expect(continuations).toBe(1);
    // Only asked once even if the idle turn is observed again.
    governor.noteIdleTurn(inferenceDone(overThreshold), terminal);
    expect(continuations).toBe(1);

    const actions = governor.interceptIdleContinuation(
      emptyMessage(),
      capabilities,
    );
    expect(actions).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
    ] as ReactorAction[]);
    // The continuation was consumed; nothing further is intercepted.
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("an idle over-threshold turn arms an emit continuation without a closure", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);

    const terminal: ReactorAction[] = [{ type: "reply", content: "done" }];
    expect(governor.noteIdleTurn(inferenceDone(overThreshold), terminal)).toBe(
      true,
    );
    // Only arms once even if the idle turn is observed again.
    expect(governor.noteIdleTurn(inferenceDone(overThreshold), terminal)).toBe(
      false,
    );

    const actions = governor.interceptIdleContinuation(
      emptyMessage(),
      capabilities,
    );
    expect(
      actions?.some(
        (a) =>
          a.type === "compact" &&
          "reason" in a &&
          a.reason === "context-threshold",
      ),
    ).toBe(true);
    expect(
      actions?.some(
        (a) =>
          a.type === "emit" &&
          "eventType" in a &&
          a.eventType === COMPACTION_CONTINUATION_EVENT,
      ),
    ).toBe(true);
  });

  test("idle arming with a closure fires once and never returns true", () => {
    // Single-delivery contract: a caller that both installs the legacy closure
    // and honors the boolean (appending an emit action on true) must still
    // deliver exactly once. The closure fires; the return stays false.
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);

    const terminal: ReactorAction[] = [{ type: "reply", content: "done" }];
    expect(governor.noteIdleTurn(inferenceDone(overThreshold), terminal)).toBe(
      false,
    );
    expect(continuations).toBe(1);
    // A repeated idle turn neither refires nor arms.
    expect(governor.noteIdleTurn(inferenceDone(overThreshold), terminal)).toBe(
      false,
    );
    expect(continuations).toBe(1);
  });

  // Idle compact with an empty continuation previously left postCompactInfer
  // unset, so resumeAfterCompact never fired and notePostCompact never ran —
  // the Ctx meter stayed on pre-compact lastTurnUsage until the next user turn.
  test("idle empty compact syncs the meter after shrink without a following user turn", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    const large = turnsOfLength(10, 200);
    governor.noteInferenceDone(inferenceDone(overThreshold), large);
    expect(governor.usingEstimate).toBe(false);
    const before = governor.estimatedTokens;

    governor.noteIdleTurn(inferenceDone(overThreshold), [
      { type: "reply", content: "done" },
    ]);
    expect(continuations).toBe(1);

    const actions = governor.interceptIdleContinuation(
      emptyMessage(),
      capabilities,
    );
    expect(actions).toEqual([
      {
        type: "compact",
        compactor: "pruning-compactor",
        reason: "context-threshold",
      },
    ] as ReactorAction[]);
    // A second continuation re-enters decide after the compact cycle so the
    // governor can adopt the shrunk turns — without starting a new inference.
    expect(continuations).toBe(2);

    const shrunk = turnsOfLength(3, 20);
    // resumeAfterCompact must arm the meter-only path (not infer) for empty idle.
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");
    governor.notePostCompact(shrunk);

    expect(governor.usingEstimate).toBe(true);
    expect(governor.estimatedTokens).toBeLessThan(before);
    expect(governor.estimatedTokens).toBe(governor.syncFromTurns(shrunk));
  });

  test("an operator message that races the idle continuation still compacts, then re-infers", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    governor.noteIdleTurn(inferenceDone(overThreshold), [
      { type: "reply", content: "done" },
    ]);

    const raced = {
      type: "message.received",
      message: { content: "next question" },
    } as ReactorInboundEvent;
    const actions = governor.interceptIdleContinuation(raced, capabilities);
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
    // A second continuation is requested so the operator message gets answered
    // after the compact cycle.
    expect(continuations).toBe(2);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");
  });

  test("idle turns with follow-up work or under threshold never arm idle compaction", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);

    governor.noteIdleTurn(inferenceDone(1000), [
      { type: "reply", content: "x" },
    ]);
    expect(continuations).toBe(0);

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    governor.noteIdleTurn(inferenceDone(overThreshold), [
      { type: "reply", content: "x" },
      { type: "infer" },
    ]);
    expect(continuations).toBe(0);
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("arms from the running local estimate when usage is zero", () => {
    const governor = createCompactionGovernor(() => undefined);
    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    const turns = turnsOfLength(10, Math.ceil(overThresholdChars / 10));
    governor.noteInferenceDone(inferenceDoneWithoutUsage(), turns);

    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("arms from the running local estimate when usage is omitted", () => {
    const governor = createCompactionGovernor(() => undefined);
    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    const turns = turnsOfLength(10, Math.ceil(overThresholdChars / 10));
    governor.noteInferenceDone(inferenceDoneMissingUsage(), turns);

    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
  });

  test("stays inert when usage is missing but the accumulated estimate is small", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(
      inferenceDoneWithoutUsage(),
      turnsOfLength(10, 4),
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("arms from accumulated growth across many turns when usage is absent", () => {
    // A single turn's content stays well under the threshold; only the sum
    // across a long conversation crosses it. Measuring the latest turn alone
    // would never arm here.
    const governor = createCompactionGovernor(() => undefined);
    const perTurnChars = 2000;
    const turns = turnsOfLength(200, perTurnChars);
    governor.noteInferenceDone(inferenceDoneWithoutUsage(), turns);

    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("prefers provider usage over the local estimate when usage is present", () => {
    const governor = createCompactionGovernor(() => undefined);
    // Local estimate is huge; reported usage is small. Prefer the provider.
    const hugeTurns = turnsOfLength(200, 2000);
    governor.noteInferenceDone(inferenceDone(1000), hugeTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    // Provider reports over threshold with a small local estimate → arm.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
  });

  test("syncFromTurns keeps the running estimate current outside arming", () => {
    const governor = createCompactionGovernor(() => undefined);
    expect(governor.estimatedTokens).toBe(0);

    const turns = turnsOfLength(4, 40);
    expect(governor.syncFromTurns(turns)).toBe(40); // 4 turns * 10 tokens
    expect(governor.estimatedTokens).toBe(40);

    // A rewrite (compaction) shrinks without needing inference.done.
    expect(governor.syncFromTurns(turnsOfLength(1, 8))).toBe(2);
    expect(governor.estimatedTokens).toBe(2);
  });

  test("only intercepts on tool.done with a pending infer", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(
        inferenceDone(overThreshold),
        inferAction,
        capabilities,
      ),
    ).toBeNull();
    expect(
      governor.interceptActions(
        toolDone(),
        [{ type: "reply", content: "x" }],
        capabilities,
      ),
    ).toBeNull();
  });

  test("stays inert below the minimum-turn floor no matter how far over threshold", () => {
    // A single turn is the compactor no-op floor. Arming here would spend a
    // reactor cycle that cannot shrink anything.
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(
      inferenceDone(overThreshold * 10),
      turnsOfLength(1, 1),
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("arms on tool.done from a live estimate even when the last snapshot was under threshold", () => {
    // Usage is omitted (pending is derived from the local estimate, which
    // starts small and stays false), but the tool result that follows is
    // itself large enough to cross the ordinary threshold before the next
    // inference.done ever runs.
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDoneWithoutUsage(), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    governor.syncFromTurns(
      turnsOfLength(10, Math.ceil(overThresholdChars / 10)),
    );

    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("never arms at the exact turn count createPruningCompactor no-ops on", () => {
    // createPruningCompactor's own no-op floor (session/compactor.ts) is
    // compactorNoOpFloor(). Arming at or below it would spend a reactor cycle
    // that is guaranteed to shrink nothing.
    const floor = compactorNoOpFloor();
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(
      inferenceDone(overThreshold),
      turnsOfLength(floor, 1),
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("arms one turn past the floor createPruningCompactor no-ops on", () => {
    const floor = compactorNoOpFloor();
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(
      inferenceDone(overThreshold),
      turnsOfLength(floor + 1, 1),
    );
    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("does not catch a huge tool result mid-cycle when the provider reported real usage", () => {
    // Disclosed, accepted gap: the live tool.done re-check only re-derives
    // arming from the local estimate when the last inference.done snapshot
    // came from that same estimate (usingEstimate). When the provider
    // reported real usage under threshold, that snapshot is trusted as
    // authoritative until the next inference.done — a huge tool result
    // arriving in between is not caught until then, unlike the
    // usage-omitted case covered above.
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    const overThresholdChars = (compactionThresholdFor("m") + 1) * 4;
    governor.syncFromTurns(
      turnsOfLength(10, Math.ceil(overThresholdChars / 10)),
    );

    // Still null: the live estimate is now over threshold, but the last
    // arming decision trusted reported usage, so it is not re-checked here.
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("notePostCompact syncs the shrunk turns and keeps the estimate authoritative until the next inference.done", () => {
    const governor = createCompactionGovernor(() => undefined);
    const large = turnsOfLength(10, 200);
    governor.noteInferenceDone(inferenceDone(overThreshold), large);
    expect(governor.usingEstimate).toBe(false);
    const before = governor.estimatedTokens;

    const shrunk = turnsOfLength(3, 20);
    governor.notePostCompact(shrunk);

    expect(governor.usingEstimate).toBe(true);
    expect(governor.estimatedTokens).toBeLessThan(before);
    expect(governor.estimatedTokens).toBe(governor.syncFromTurns(shrunk));

    // Provider-reported usage on the next turn clears the estimate flag.
    governor.noteInferenceDone(inferenceDone(1000), shrunk);
    expect(governor.usingEstimate).toBe(false);
  });

  test("clears the latch once usage drops under the high watermark", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    // Next crossing of high arms immediately — no growth delta required.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("overflow still compacts while the latch blocks the proactive path", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    const actions = governor.interceptOverflow(overflowError(), capabilities);
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("spacer-echo terminal does not arm idle compact", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(
      inferenceDone(overThreshold, LEGACY_COMPACT_SPACER_TEXT),
      tenTurns,
    );
    governor.noteIdleTurn(
      inferenceDone(overThreshold, LEGACY_COMPACT_SPACER_TEXT),
      [{ type: "reply", content: LEGACY_COMPACT_SPACER_TEXT }],
    );
    expect(continuations).toBe(0);
    governor.noteIdleTurn(inferenceDone(overThreshold, COMPACT_SPACER_TEXT), [
      { type: "reply", content: COMPACT_SPACER_TEXT },
    ]);
    expect(continuations).toBe(0);
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();

    governor.noteIdleTurn(inferenceDone(overThreshold, "done"), [
      { type: "reply", content: "done" },
    ]);
    expect(continuations).toBe(1);
  });

  test("manual compact bypasses the occupancy governor on an idle session", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);

    expect(governor.requestManual("keep the auth discussion")).toBe("kick");
    expect(governor.extraInstructions).toBe("keep the auth discussion");
    expect(governor.requestManual("")).toBe("armed");
    expect(governor.extraInstructions).toBe("keep the auth discussion");

    const actions = governor.interceptIdleContinuation(
      emptyMessage(),
      capabilities,
    );
    expect(
      actions?.some(
        (a) =>
          a.type === "compact" &&
          "reason" in a &&
          a.reason === OPERATOR_COMPACT_REASON,
      ),
    ).toBe(true);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");
    expect(governor.resumeAfterCompact(emptyMessage())).toBeNull();
  });

  test("manual compact during a tool pause continues the in-flight turn", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);

    expect(governor.requestManual("", { inFlight: true })).toBe("armed");
    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(
      actions?.some(
        (a) =>
          a.type === "compact" &&
          "reason" in a &&
          a.reason === OPERATOR_COMPACT_REASON,
      ),
    ).toBe(true);
    expect(actions?.some((a) => a.type === "infer")).toBe(false);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");
  });

  test("manual compact no-ops below the compactor floor", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(
      inferenceDone(overThreshold),
      turnsOfLength(1, 1),
    );
    expect(governor.requestManual("focus on tests")).toBe("noop");
    expect(governor.extraInstructions).toBeUndefined();
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("manual compact hydrates from restored turns without a prior decide", () => {
    const governor = createCompactionGovernor(undefined);
    expect(governor.compactTurnCount).toBe(0);
    expect(governor.requestManual("keep the auth discussion")).toBe("noop");
    expect(
      governor.requestManual("keep the auth discussion", { turns: tenTurns }),
    ).toBe("kick");
    expect(governor.compactTurnCount).toBe(10);
    expect(governor.extraInstructions).toBe("keep the auth discussion");
  });

  test("restoreExtraInstructions hydrates a new governor from a compact record", () => {
    const written = {
      strategy: "pruning-compactor",
      version: "1",
      parameters: { extraInstructions: "keep the auth discussion" },
      reason: "compacted",
      decisions: {},
    };
    expect(stickyExtraInstructionsFromRecords([written])).toBe(
      "keep the auth discussion",
    );

    const rebuilt = createCompactionGovernor(undefined);
    expect(rebuilt.extraInstructions).toBeUndefined();
    rebuilt.restoreExtraInstructions(
      stickyExtraInstructionsFromRecords([written]),
    );
    expect(rebuilt.extraInstructions).toBe("keep the auth discussion");
    rebuilt.restoreExtraInstructions(undefined);
    expect(rebuilt.extraInstructions).toBe("keep the auth discussion");
  });

  test("sticky extra instructions skip empty values and later non-pruning records", () => {
    expect(
      stickyExtraInstructionsFromRecords([
        {
          strategy: "other",
          parameters: { extraInstructions: "ignore me" },
        },
        {
          strategy: "pruning-compactor",
          parameters: { extraInstructions: "  keep tests  " },
        },
        {
          strategy: "pruning-compactor",
          parameters: { extraInstructions: "older" },
        },
      ]),
    ).toBe("keep tests");
    expect(
      stickyExtraInstructionsFromRecords([
        {
          strategy: "pruning-compactor",
          parameters: { extraInstructions: "" },
        },
        {
          strategy: "pruning-compactor",
          parameters: { extraInstructions: 12 },
        },
      ]),
    ).toBeUndefined();
  });

  test("second /compact during the apply-to-meter window does not double-fold", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(governor.requestManual("keep the auth discussion")).toBe("kick");
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).not.toBeNull();

    expect(governor.requestManual("also keep the billing notes")).toBe("armed");
    expect(governor.extraInstructions).toBe("also keep the billing notes");
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");
  });
});

describe("post-compact above-threshold latch (CL-9006)", () => {
  // Half the wide gap: growth that used to re-arm under the old resume delta
  // must no longer re-arm on its own.
  const smallGrowth = Math.floor(wideDelta / 2);

  test("resume-delta-scale growth while still over threshold does not re-arm", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    // Post-compact measurement stays over the high watermark: the latch sets.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    // Growth by half the wide gap must NOT re-arm on its own.
    governor.noteInferenceDone(
      inferenceDone(overThreshold + smallGrowth),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    // The idle path shares the same latch.
    governor.noteIdleTurn(inferenceDone(overThreshold + smallGrowth), [
      { type: "reply", content: "done" },
    ]);
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("a still-over fold reports non-convergence instead of re-arming on a wide gap", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(governor.foldNonConverged).toBe(true);
    governor.noteInferenceDone(
      inferenceDone(overThreshold + wideDelta),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    expect(governor.foldNonConverged).toBe(true);
  });

  test("foldNonConvergedNotice names the still-over fold for the operator", () => {
    expect(foldNonConvergedNotice()).toMatch(/did not reduce occupancy/i);
    expect(foldNonConvergedNotice()).toMatch(/paused/i);
  });

  test("ChatDirector emits the non-convergence notice once after a still-over fold", async () => {
    const director = createChatDirector("sys", [], {});
    const caps: ReactorCapabilities = {
      infer: () => ({ type: "infer" }),
      executeTools: () => ({ type: "execute_tools", calls: [] }),
      suspend: (gate) => ({ type: "suspend", gate }),
      fork: (mode, forkId) => ({ type: "fork", mode, forkId }),
      emit: (eventType, data) => ({ type: "emit", eventType, data }),
      reply: (content: string) => ({ type: "reply", content }),
      checkpoint: (message = "") => ({ type: "checkpoint", message }),
      compact: (compactor, reason) => ({ type: "compact", compactor, reason }),
      wait: () => ({ type: "wait" }),
      done: () => ({ type: "done" }),
    };
    const manyTurns = {
      turns: Array.from({ length: 8 }, () => ({
        role: "assistant" as const,
        content: [],
        model: "test-model",
        timestamp: 0,
      })),
      activeForks: [],
      pendingOperations: [],
      activeGates: [],
      tokenUsage: usage(overThreshold),
      lastCycleUsage: null,
      lastCycleSource: null,
      sessionId: "test-session",
    };
    const done = (input: number): ReactorInboundEvent =>
      ({
        type: "inference.done",
        turn: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call-1",
              name: "read_file",
              arguments: { path: "x.ts" },
            },
          ],
          model: "test-model",
          timestamp: 0,
        },
        usage: usage(input),
        source: {
          sourceId: "test",
          provider: "openai",
          model: "test-model",
        },
      }) as ReactorInboundEvent;
    const toolDoneEvent = {
      type: "tool.done",
      result: { callId: "call-1", content: "ok", isError: false },
    } as ReactorInboundEvent;

    await director.decide(done(overThreshold), manyTurns as never, caps);
    await director.decide(toolDoneEvent, manyTurns as never, caps);
    const post = await director.decide(
      done(overThreshold),
      manyTurns as never,
      caps,
    );
    const arr = Array.isArray(post) ? post : [post];
    const notices = arr.filter(
      (a) =>
        a.type === "emit" &&
        "eventType" in a &&
        a.eventType === COMPACTION_FOLD_NONCONVERGED_EVENT,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      data: { notice: foldNonConvergedNotice() },
    });

    const again = await director.decide(
      done(overThreshold + 1),
      manyTurns as never,
      caps,
    );
    const againArr = Array.isArray(again) ? again : [again];
    expect(
      againArr.filter(
        (a) =>
          a.type === "emit" &&
          "eventType" in a &&
          a.eventType === COMPACTION_FOLD_NONCONVERGED_EVENT,
      ),
    ).toHaveLength(0);
  });

  test("the consecutive-compact cap holds across tool-call occupancy", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    // Post-compact measurement still over: the fold is non-converged and the
    // cap is spent, even past a wide gap and tool-call occupancy.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(governor.foldNonConverged).toBe(true);
    governor.noteInferenceDone(
      inferenceDoneWithTools(overThreshold + 2 * wideDelta),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    governor.noteIdleTurn(
      inferenceDoneWithTools(overThreshold + 2 * wideDelta),
      [{ type: "reply", content: "done" }],
    );
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("overflow recoveries are bounded across still-over measurements", () => {
    const governor = createCompactionGovernor(() => undefined);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");

    // Still-over post-compact measurement: no relief, budget stays spent.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).toBeNull();
  });

  test("an under-threshold fold restores the overflow budget", () => {
    const governor = createCompactionGovernor(() => undefined);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    // Fold evidence: usage back under the watermark restores the budget.
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
  });

  test("auto re-arm after an operator compact uses the identical latch", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(governor.requestManual("", { inFlight: true })).toBe("armed");
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    // Post-operator-compact measurement stays over: small growth must not
    // re-arm the automatic path.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    governor.noteInferenceDone(
      inferenceDone(overThreshold + smallGrowth),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    expect(governor.foldNonConverged).toBe(true);

    // Wide gap does not silently re-arm the automatic path after a still-over
    // operator fold; the fold already reported non-convergence.
    governor.noteInferenceDone(
      inferenceDone(overThreshold + wideDelta),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });
});

describe("cache expiry never folds (CL-8914)", () => {
  const MINUTE_MS = 60_000;

  function racedMessage(): ReactorInboundEvent {
    return {
      type: "message.received",
      message: { content: "next question" },
    } as ReactorInboundEvent;
  }

  test("an armed threshold fold is not disturbed by idle re-entry", () => {
    let nowMs = 30_000_000;
    const governor = createCompactionGovernor(
      () => undefined,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    // Threshold arming owns the over-threshold session and fires at the tool
    // pause; a message.received re-entry is not its trigger.
    nowMs += 5 * MINUTE_MS + 1;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
    expect(
      governor.interceptIdleContinuation(racedMessage(), capabilities),
    ).toBeNull();
  });
});

describe("handoff arming (/handoff)", () => {
  const pivot = (content: string): ReactorInboundEvent =>
    ({
      type: "message.received",
      message: { content },
    }) as ReactorInboundEvent;

  test("requestHandoff arms the operator fold and keeps the pivot instructions", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    expect(governor.extraInstructions).toBe("now do the UI audit");
  });

  test("blank instructions still arm; the fold uses the default structured summary", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("   ")).toBe("armed");
    expect(governor.extraInstructions).toBeUndefined();
  });

  test("requestHandoff noops at or below the fold floor and arms nothing", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(turnsOfLength(1, 1));
    expect(governor.requestHandoff("now do the UI audit")).toBe("noop");
    expect(governor.extraInstructions).toBeUndefined();
    expect(
      governor.interceptIdleContinuation(
        pivot("now do the UI audit"),
        capabilities,
      ),
    ).toBeNull();
  });

  test("a tool-batch pause runs the single operator fold, then continues", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");

    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.find((a) => a.type === "compact")).toMatchObject({
      compactor: "pruning-compactor",
      reason: OPERATOR_COMPACT_REASON,
    });
    expect(actions?.some((a) => a.type === "infer")).toBe(false);
    expect(
      actions?.some(
        (a) =>
          a.type === "emit" && a.eventType === COMPACTION_CONTINUATION_EVENT,
      ),
    ).toBe(true);
    // Firing clears the arming: the pivot arrival must not fold twice.
    expect(
      governor.interceptIdleContinuation(
        pivot("now do the UI audit"),
        capabilities,
      ),
    ).toBeNull();
  });

  test("the pivot arrival folds with the operator reason, then re-infers", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");

    const actions = governor.interceptIdleContinuation(
      pivot("now do the UI audit"),
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.find((a) => a.type === "compact")).toMatchObject({
      compactor: "pruning-compactor",
      reason: OPERATOR_COMPACT_REASON,
    });
    // Handoff always starts the next turn: a content-bearing pivot re-infers
    // after the fold (never the meter-only path an idle auto-compact takes).
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");
    // The single operator fold is spent: a replayed arrival folds nothing.
    expect(
      governor.interceptIdleContinuation(
        pivot("now do the UI audit"),
        capabilities,
      ),
    ).toBeNull();
  });

  test("instructions stay sticky for the summary after the fold fires", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.interceptIdleContinuation(
      pivot("now do the UI audit"),
      capabilities,
    );
    expect(governor.extraInstructions).toBe("now do the UI audit");
  });

  test.each<{
    label: string;
    kind: "pivot" | "actions" | "extras";
  }>([
    {
      label: "disarms so the next operator message does not fold",
      kind: "pivot",
    },
    { label: "does not invent pending", kind: "actions" },
    { label: "clears sticky extraInstructions", kind: "extras" },
  ])("cancelManual $label", ({ kind }) => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.cancelManual();
    if (kind === "pivot") {
      expect(
        governor.interceptIdleContinuation(
          pivot("now do the UI audit"),
          capabilities,
        ),
      ).toBeNull();
    } else if (kind === "actions") {
      expect(
        governor.interceptActions(toolDone(), inferAction, capabilities),
      ).toBeNull();
    } else {
      expect(governor.extraInstructions).toBeUndefined();
    }
  });

  test("cancelManual restores extraInstructions from a prior successful fold", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("keep the UI audit")).toBe("armed");
    governor.interceptIdleContinuation(
      pivot("keep the UI audit"),
      capabilities,
    );
    expect(governor.extraInstructions).toBe("keep the UI audit");
    expect(governor.requestHandoff("failed pivot: drop this")).toBe("armed");
    governor.cancelManual();
    expect(governor.extraInstructions).toBe("keep the UI audit");
  });

  test("failed-pivot instructions are not in a later threshold summary prompt", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.cancelManual();
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
    const prompt = buildSummaryPrompt(
      tenTurns,
      governor.extraInstructions !== undefined
        ? { extraInstructions: governor.extraInstructions }
        : undefined,
    );
    expect(prompt).not.toContain("now do the UI audit");
    expect(prompt).not.toContain("Operator compact instructions");
  });

  test("cancelManual restores idlePending so an idle threshold fold still fires", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.noteIdleTurn(inferenceDone(overThreshold), [
        { type: "reply", content: "done" },
      ]),
    ).toBe(true);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.cancelManual();
    const actions = governor.interceptIdleContinuation(
      emptyMessage(),
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.find((a) => a.type === "compact")).toMatchObject({
      reason: "context-threshold",
    });
  });

  test("threshold pending survives cancelManual so a tool pause still folds", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    const cancelled = createCompactionGovernor(undefined);
    cancelled.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(cancelled.requestHandoff("now do the UI audit")).toBe("armed");
    cancelled.cancelManual();
    const actions = cancelled.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
    expect(actions?.find((a) => a.type === "compact")).toMatchObject({
      reason: "context-threshold",
    });
  });

  // One arm-fold-cancel sequence; rows vary only in the channel the fold
  // fired on and what (if anything) happens between the fold and the cancel.
  test.each<{
    title: string;
    fire: "idle" | "tool" | "overflow";
    midRequests?: {
      turns?: typeof tenTurns;
      text: string;
      result: "armed" | "noop";
    }[];
    idleSpent?: boolean;
  }>([
    {
      title:
        "cancelManual after a fired idle fold keeps extras and does not re-arm",
      fire: "idle",
      idleSpent: true,
    },
    {
      title:
        "cancelManual after a fired tool-pause fold keeps extras and does not re-arm",
      fire: "tool",
      idleSpent: true,
    },
    { title: "overflow then cancelManual keeps extras", fire: "overflow" },
    {
      title: "noop then cancelManual does not wipe extras from a prior fold",
      fire: "idle",
      midRequests: [
        { turns: turnsOfLength(1, 1), text: "wipe this", result: "noop" },
      ],
    },
    {
      title:
        "double requestHandoff then cancel restores committed extras, not the first uncommitted",
      fire: "idle",
      midRequests: [
        { text: "first uncommitted", result: "armed" },
        { text: "second uncommitted", result: "armed" },
      ],
    },
  ])("$title", ({ fire, midRequests = [], idleSpent = false }) => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("keep the UI audit")).toBe("armed");
    const fired =
      fire === "overflow"
        ? governor.interceptOverflow(overflowError(), capabilities)
        : fire === "idle"
          ? governor.interceptIdleContinuation(
              pivot("keep the UI audit"),
              capabilities,
            )
          : governor.interceptActions(toolDone(), inferAction, capabilities);
    expect(fired).not.toBeNull();
    for (const request of midRequests) {
      if (request.turns) governor.syncFromTurns(request.turns);
      expect(governor.requestHandoff(request.text)).toBe(request.result);
    }
    governor.cancelManual();
    expect(governor.extraInstructions).toBe("keep the UI audit");
    if (idleSpent) {
      expect(
        governor.interceptIdleContinuation(emptyMessage(), capabilities),
      ).toBeNull();
    }
  });

  test("cancelManual after a fired idle fold does not restore a second idle compact", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.noteIdleTurn(inferenceDone(overThreshold), [
        { type: "reply", content: "done" },
      ]),
    ).toBe(true);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    expect(
      governor.interceptIdleContinuation(
        pivot("now do the UI audit"),
        capabilities,
      ),
    ).not.toBeNull();
    governor.cancelManual();
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("empty trailing after a successful fold uses the default structured summary", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("keep the UI audit")).toBe("armed");
    governor.interceptIdleContinuation(
      pivot("keep the UI audit"),
      capabilities,
    );
    expect(governor.requestHandoff("   ")).toBe("armed");
    expect(governor.extraInstructions).toBeUndefined();
    const prompt = buildSummaryPrompt(
      tenTurns,
      governor.extraInstructions !== undefined
        ? { extraInstructions: governor.extraInstructions }
        : undefined,
    );
    expect(prompt).not.toContain("keep the UI audit");
    expect(prompt).not.toContain("Operator compact instructions");
  });

  test("noop then cancel after a restored idle fold has already fired does not re-arm idle", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.noteIdleTurn(inferenceDone(overThreshold), [
        { type: "reply", content: "done" },
      ]),
    ).toBe(true);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.cancelManual();
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).not.toBeNull();
    governor.syncFromTurns(turnsOfLength(1, 1));
    expect(governor.requestHandoff("wipe this")).toBe("noop");
    governor.cancelManual();
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("handoff then overflow spends the fold on every continuation channel", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    const overflow = governor.interceptOverflow(overflowError(), capabilities);
    expect(overflow).not.toBeNull();
    expect(overflow?.find((a) => a.type === "compact")).toMatchObject({
      reason: "context-overflow",
    });
    // Neither the pivot arrival nor a tool pause folds a second time.
    expect(
      governor.interceptIdleContinuation(
        pivot("now do the UI audit"),
        capabilities,
      ),
    ).toBeNull();
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    expect(governor.extraInstructions).toBe("now do the UI audit");
  });

  test("overflow spends idle threshold arming so later empty arrival does not fold", () => {
    const governor = createCompactionGovernor(undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.noteIdleTurn(inferenceDone(overThreshold), [
        { type: "reply", content: "done" },
      ]),
    ).toBe(true);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });
});
