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
  compactFloorNoopNotice,
  createCompactionGovernor,
  stickyExtraInstructionsFromRecords,
} from "./compaction.js";
import {
  compactionResumeDeltaFor,
  compactionThresholdFor,
} from "../provider/context-window.js";
import {
  COMPACTOR_KEEP_RECENT_TURNS,
  COMPACT_SPACER_TEXT,
  LEGACY_COMPACT_SPACER_TEXT,
  compactorNoOpFloor,
} from "../session/compactor.js";

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
): Extract<ReactorInboundEvent, { type: "inference.done" }> {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: text.length > 0 ? [{ type: "text", text }] : [],
    },
    usage: usage(input),
    source: { sourceId: "s", provider: "p", model: "m" },
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
const resumeDelta = compactionResumeDeltaFor("m");
const inferAction: ReactorAction[] = [{ type: "infer" }];
const tenTurns = turnsOfLength(10, 1);
const threeTurns = turnsOfLength(3, 1);

describe("compaction governor", () => {
  test("swaps the post-tool infer for a compact action once the threshold is crossed", () => {
    let continuations = 0;
    const governor = createCompactionGovernor(() => continuations++);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);

    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
    expect(actions?.some((a) => a.type === "infer")).toBe(false);
    expect(continuations).toBe(1);

    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");
    expect(governor.resumeAfterCompact(emptyMessage())).toBeNull();
  });

  test("stays inert below the threshold or with few turns", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), threeTurns);
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

  test("recovers from context overflow a bounded number of times", () => {
    const governor = createCompactionGovernor(() => undefined);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).toBeNull();

    governor.noteInferenceDone(inferenceDone(1000), tenTurns);
    expect(
      governor.interceptOverflow(overflowError(), capabilities),
    ).not.toBeNull();
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
    // Two turns is well under MIN_TURNS_TO_COMPACT. createPruningCompactor
    // no-ops at the same floor (see session/compactor.ts), so arming here
    // would spend a reactor cycle that cannot shrink anything.
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(
      inferenceDone(overThreshold * 10),
      turnsOfLength(2, 1),
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
    // compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS). Arming at or below it
    // would spend a reactor cycle that is guaranteed to shrink nothing.
    const floor = compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS);
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
    const floor = compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS);
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

  test("does not re-arm after a compact that remains over the high watermark", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    // Post-compact snapshot is still over high; growth hysteresis must hold
    // the next arm until usage grows by resumeDelta.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
  });

  test("re-arms after usage grows by the resume delta past the last compact", () => {
    const governor = createCompactionGovernor(() => undefined);
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    governor.noteInferenceDone(
      inferenceDone(overThreshold + resumeDelta),
      tenTurns,
    );
    const actions = governor.interceptActions(
      toolDone(),
      inferAction,
      capabilities,
    );
    expect(actions).not.toBeNull();
    expect(actions?.some((a) => a.type === "compact")).toBe(true);
  });

  test("clears hysteresis once usage drops under the high watermark", () => {
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

  test("overflow still compact while hysteresis blocks the proactive path", () => {
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

  test("consecutive threshold and idle compacts are bounded until occupancy", () => {
    const governor = createCompactionGovernor(() => undefined);
    const echo = LEGACY_COMPACT_SPACER_TEXT;
    governor.noteInferenceDone(inferenceDone(overThreshold, echo), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    governor.noteInferenceDone(inferenceDone(overThreshold, echo), tenTurns);
    governor.noteInferenceDone(
      inferenceDone(overThreshold + resumeDelta, echo),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();

    governor.noteInferenceDone(
      inferenceDone(overThreshold + resumeDelta, echo),
      tenTurns,
    );
    governor.noteInferenceDone(
      inferenceDone(overThreshold + 2 * resumeDelta, echo),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    governor.noteIdleTurn(
      inferenceDone(overThreshold + 2 * resumeDelta, echo),
      [{ type: "reply", content: "done" }],
    );
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();

    governor.noteInferenceDone(
      inferenceDone(overThreshold + 3 * resumeDelta, "real work"),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    governor.noteInferenceDone(
      inferenceDoneWithTools(overThreshold + 4 * resumeDelta),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
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
    governor.noteInferenceDone(inferenceDone(overThreshold), threeTurns);
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

  test("noop /compact below the floor tells the operator instructions were not saved", () => {
    expect(compactFloorNoopNotice("")).toBe("Nothing to compact yet.");
    expect(compactFloorNoopNotice("keep the auth discussion")).toBe(
      "Nothing to compact yet. Instructions were not saved.",
    );
  });
});

describe("provider-aware idle recompress (CL-8745)", () => {
  const MINUTE_MS = 60_000;

  function ttlInferenceDone(
    modelOrSource:
      | string
      | { sourceId?: string; provider?: string; model?: string },
    withTools: boolean,
  ): Extract<ReactorInboundEvent, { type: "inference.done" }> {
    const source =
      typeof modelOrSource === "string"
        ? { sourceId: "s", provider: "p", model: modelOrSource }
        : {
            sourceId: modelOrSource.sourceId ?? "s",
            provider: modelOrSource.provider ?? "p",
            model: modelOrSource.model ?? "m",
          };
    return {
      type: "inference.done",
      turn: {
        role: "assistant",
        content: withTools
          ? [
              {
                type: "tool_call",
                id: "c1",
                name: "read_file",
                arguments: { path: "a.ts" },
              },
            ]
          : [{ type: "text", text: "ok" }],
      },
      usage: usage(1000),
      source,
    } as unknown as Extract<ReactorInboundEvent, { type: "inference.done" }>;
  }

  function racedMessage(): ReactorInboundEvent {
    return {
      type: "message.received",
      message: { content: "next question" },
    } as ReactorInboundEvent;
  }

  const ttlCompact = [
    {
      type: "compact",
      compactor: "pruning-compactor",
      reason: "cache-ttl-recompress",
    },
  ] as ReactorAction[];

  test("fires past the provider TTL while under threshold, meter-only on empty", () => {
    let continuations = 0;
    let nowMs = 10_000_000;
    const governor = createCompactionGovernor(
      () => continuations++,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(
      ttlInferenceDone(
        { provider: "anthropic", model: "claude-opus-4-6" },
        false,
      ),
      tenTurns,
    );

    // Inside the 5-minute Anthropic window: no fire.
    nowMs += 4 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();

    // Past the window: the same fold as the threshold path (same compactor,
    // so the fresh tail stays raw) with an attributable reason.
    nowMs += MINUTE_MS + 1;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(continuations).toBe(1);
    // Empty continuation adopts the shrunk turns without a new inference.
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");
  });

  test("production LastCycleSource: anthropic fires at 5m, codex stays quiet until 10m", () => {
    // Harness stamps { sourceId, provider, model } with a bare model, not
    // slash-form "anthropic/claude-opus-4-6". Anthropic's 5-minute window
    // must come from provider, not a dummy model string; Codex must not
    // inherit that 5-minute fire from sourceId "codex/work".
    let nowMs = 15_000_000;
    const clock = () => nowMs;
    const anthropic = createCompactionGovernor(() => undefined, "", [], clock);
    const codex = createCompactionGovernor(() => undefined, "", [], clock);
    anthropic.noteInferenceDone(
      ttlInferenceDone(
        { provider: "anthropic", model: "claude-opus-4-6" },
        false,
      ),
      tenTurns,
    );
    codex.noteInferenceDone(
      ttlInferenceDone(
        {
          sourceId: "codex/work",
          provider: "codex-responses",
          model: "gpt-5.6-luna",
        },
        false,
      ),
      tenTurns,
    );

    nowMs += 5 * MINUTE_MS + 1;
    expect(
      anthropic.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(
      codex.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();

    nowMs += 5 * MINUTE_MS;
    expect(
      codex.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
  });

  test("follows provider economics: deepseek waits out its long window, ollama never fires", () => {
    let nowMs = 20_000_000;
    const clock = () => nowMs;
    const deepseek = createCompactionGovernor(() => undefined, "", [], clock);
    const local = createCompactionGovernor(() => undefined, "", [], clock);
    deepseek.noteInferenceDone(
      ttlInferenceDone("deepseek/deepseek-chat", false),
      tenTurns,
    );
    local.noteInferenceDone(
      ttlInferenceDone("ollama/llama3.1", false),
      tenTurns,
    );

    // Past Anthropic/OpenAI windows but inside DeepSeek's hour: neither fires.
    nowMs += 30 * MINUTE_MS;
    expect(
      deepseek.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
    expect(
      local.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();

    // Past DeepSeek's hour: recompress fires; local inference still never
    // does — no remote cache means no cache benefit.
    nowMs += 31 * MINUTE_MS;
    expect(
      deepseek.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(
      local.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("production ollama LastCycleSource never fires cache-ttl-recompress", () => {
    // Harness stamps { sourceId, provider, model } with a bare model. Ollama is
    // buildOpenAISource: sourceId "ollama/default", provider openai-compatible,
    // model llama3. Keying TTL only off model would take the 10-minute default.
    let nowMs = 25_000_000;
    const governor = createCompactionGovernor(
      () => undefined,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(
      ttlInferenceDone(
        {
          sourceId: "ollama/default",
          provider: "openai-compatible",
          model: "llama3",
        },
        false,
      ),
      tenTurns,
    );

    nowMs += 11 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("stays inert with no observed cache write", () => {
    const governor = createCompactionGovernor(() => undefined);
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
  });

  test("defers to the armed threshold path while over threshold", () => {
    let nowMs = 30_000_000;
    const governor = createCompactionGovernor(
      () => undefined,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    // The "m" fixture model carries the 10-minute default TTL; advance past it.
    nowMs += 11 * MINUTE_MS;
    // Threshold arming owns the over-threshold session: no TTL double-fold.
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
    expect(
      governor.interceptIdleContinuation(racedMessage(), capabilities),
    ).toBeNull();
  });

  test("fires cache-ttl-recompress in the hysteresis gap (over-threshold, no growth)", () => {
    // Characterization, not a bug: after a threshold compact, a post-compact
    // infer at the same usage clears `pending` via growth hysteresis, so the
    // threshold path no longer owns the session. Idle past the provider TTL
    // still folds — same window- and cap-bounded path as under-threshold.
    let nowMs = 70_000_000;
    const governor = createCompactionGovernor(
      () => undefined,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    nowMs += 11 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
  });

  test("after threshold compact and gap TTL, growth-armed compact stays blocked until a tool_call", () => {
    // Threshold compact (consecutive=1) plus TTL fire in the hysteresis gap
    // (consecutive=2) fills the shared cap. Later growth that would re-arm
    // the threshold path stays blocked until a tool_call occupancy resets it.
    let nowMs = 80_000_000;
    const governor = createCompactionGovernor(
      () => undefined,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");

    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    nowMs += 11 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");

    // Post-TTL snapshot, then growth past resumeDelta — pending re-arms,
    // but the cap is full so interceptActions stays null.
    governor.noteInferenceDone(inferenceDone(overThreshold), tenTurns);
    governor.noteInferenceDone(
      inferenceDone(overThreshold + resumeDelta),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();

    governor.noteInferenceDone(
      inferenceDoneWithTools(overThreshold + 2 * resumeDelta),
      tenTurns,
    );
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).not.toBeNull();
  });

  test("does not fold under an outstanding tool batch, fires once it settles", () => {
    let continuations = 0;
    let nowMs = 40_000_000;
    const governor = createCompactionGovernor(
      () => continuations++,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(
      ttlInferenceDone("anthropic/claude-opus-4-6", true),
      tenTurns,
    );
    nowMs += 6 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
    // The batch settles (threshold path uninvolved: under threshold).
    expect(
      governor.interceptActions(toolDone(), inferAction, capabilities),
    ).toBeNull();
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(continuations).toBe(1);
  });

  test("one fire per window, then the shared consecutive-compact cap stops the spiral", () => {
    let continuations = 0;
    let nowMs = 50_000_000;
    const governor = createCompactionGovernor(
      () => continuations++,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(
      ttlInferenceDone("anthropic/claude-opus-4-6", false),
      tenTurns,
    );

    nowMs += 5 * MINUTE_MS + 1;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");
    governor.notePostCompact(tenTurns);

    // Inside the next window: no second fire.
    nowMs += 4 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();

    nowMs += MINUTE_MS + 1;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("meter");
    governor.notePostCompact(tenTurns);

    // Cap reached: the third window stays quiet.
    nowMs += 5 * MINUTE_MS + 1;
    expect(
      governor.interceptIdleContinuation(emptyMessage(), capabilities),
    ).toBeNull();
    expect(continuations).toBe(2);
  });

  test("a raced operator message past the TTL still folds, then re-infers", () => {
    let continuations = 0;
    let nowMs = 60_000_000;
    const governor = createCompactionGovernor(
      () => continuations++,
      "",
      [],
      () => nowMs,
    );
    governor.noteInferenceDone(
      ttlInferenceDone("anthropic/claude-opus-4-6", false),
      tenTurns,
    );
    nowMs += 6 * MINUTE_MS;
    expect(
      governor.interceptIdleContinuation(racedMessage(), capabilities),
    ).toEqual(ttlCompact);
    expect(continuations).toBe(1);
    // The follow-up empty continuation carries the infer that answers the
    // raced question (mirrors the threshold raced path).
    expect(governor.resumeAfterCompact(emptyMessage())).toBe("infer");
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
    governor.syncFromTurns(threeTurns);
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

  test("cancelManual disarms so the next operator message does not fold", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.cancelManual();
    expect(
      governor.interceptIdleContinuation(
        pivot("now do the UI audit"),
        capabilities,
      ),
    ).toBeNull();
  });

  test("cancelManual clears sticky extraInstructions from a failed pivot", () => {
    const governor = createCompactionGovernor(undefined);
    governor.syncFromTurns(tenTurns);
    expect(governor.requestHandoff("now do the UI audit")).toBe("armed");
    governor.cancelManual();
    expect(governor.extraInstructions).toBeUndefined();
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
});
