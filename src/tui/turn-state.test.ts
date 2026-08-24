import { describe, expect, test } from "bun:test";

import {
  initialTurnState,
  turnStateFromEvent,
  turnStateGateClosed,
  turnStateGateOpened,
  turnStateOnInterrupt,
  turnStateOnSubmit,
} from "./turn-state.js";

const fold = (
  events: readonly {
    type: string;
    data?: unknown;
    state?: string;
    text?: string;
  }[],
  startMs = 0,
) =>
  events.reduce(
    (state, event, i) => turnStateFromEvent(state, event, startMs + i + 1),
    initialTurnState(startMs),
  );

describe("turnStateFromEvent", () => {
  test("start awaits the first token", () => {
    const s = fold([{ type: "inference.start" }]);
    expect(s.status).toBe("running");
    expect(s.awaitingResponse).toBe(true);
    expect(s.streamingType).toBeNull();
  });

  test("text and thinking deltas set the streaming phase", () => {
    expect(
      fold([{ type: "inference.start" }, { type: "inference.text.delta" }]).streamingType,
    ).toBe("text");
    expect(
      fold([{ type: "inference.start" }, { type: "inference.thinking.delta" }]).streamingType,
    ).toBe("thinking");
    // Canonical bridge alias — fixtures may emit thinking.delta directly.
    expect(fold([{ type: "inference.start" }, { type: "thinking.delta" }]).streamingType).toBe(
      "thinking",
    );
  });

  test("text deltas accumulate a live token count, thinking deltas do not", () => {
    const s = fold([
      { type: "inference.start" },
      { type: "inference.text.delta" },
      { type: "inference.text.delta" },
      { type: "inference.thinking.delta" },
    ]);
    expect(s.streamTokenCount).toBe(2);
  });

  test("a new submit resets the token count", () => {
    const midTurn = fold([{ type: "inference.start" }, { type: "inference.text.delta" }]);
    expect(midTurn.streamTokenCount).toBe(1);
    const next = turnStateOnSubmit(midTurn, 10);
    expect(next.streamTokenCount).toBe(0);
  });

  test("tool call tracks the current tool and clears on result", () => {
    const running = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.end", data: { name: "bash" } },
    ]);
    expect(running.streamingType).toBe("tool");
    expect(running.currentToolName).toBe("bash");

    const done = turnStateFromEvent(running, { type: "tool.done" }, 100);
    expect(done.currentToolName).toBeNull();
    expect(done.awaitingResponse).toBe(true);
  });

  test("tool.start reads the nested call name", () => {
    expect(fold([{ type: "tool.start", data: { call: { name: "grep" } } }]).currentToolName).toBe(
      "grep",
    );
  });

  test("a call's own name-only start and end announcements do not double-count", () => {
    const running = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.start", data: { name: "bash" } },
      { type: "inference.tool_call.end", data: { name: "bash" } },
    ]);
    expect(running.activeToolCalls).toHaveLength(1);
  });

  test("a name-only streamed announcement and an id-bearing tool.start for the same call settle on one tool.done", () => {
    // Regression for CL-5645: inference.tool_call.start streamed the call
    // under its name (no callId yet); tool.start then announced the same
    // call under a real id. One tool.done must clear both records, not
    // leave a name-keyed duplicate pinning activeToolCalls forever.
    const running = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.start", data: { name: "bash" } },
      { type: "tool.start", data: { call: { id: "call_1", name: "bash" } } },
    ]);
    expect(running.activeToolCalls).toHaveLength(1);

    const done = turnStateFromEvent(
      running,
      { type: "tool.done", data: { result: { callId: "call_1" } } },
      200,
    );
    expect(done.activeToolCalls).toHaveLength(0);

    const settled = turnStateFromEvent(done, { type: "inference.done" }, 201);
    expect(settled.status).toBe("done");
    expect(settled.isProcessing).toBe(false);
  });

  test("two concurrent calls to the same tool resolve independently", () => {
    const running = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.start", data: { name: "grep" } },
      { type: "inference.tool_call.start", data: { name: "grep" } },
      { type: "tool.start", data: { call: { id: "call_1", name: "grep" } } },
      { type: "tool.start", data: { call: { id: "call_2", name: "grep" } } },
    ]);
    expect(running.activeToolCalls).toHaveLength(2);

    const oneDone = turnStateFromEvent(
      running,
      { type: "tool.done", data: { result: { callId: "call_1" } } },
      200,
    );
    expect(oneDone.activeToolCalls).toHaveLength(1);

    const bothDone = turnStateFromEvent(
      oneDone,
      { type: "tool.done", data: { result: { callId: "call_2" } } },
      201,
    );
    expect(bothDone.activeToolCalls).toHaveLength(0);
  });

  test("tool.done only sets awaitingResponse once every parallel call has finished", () => {
    // Regression for CL-5661: with a fan-out of two outstanding calls, the
    // first tool.done must not claim the turn is idle while the second call
    // is still running — that falsely tells consumers (stall watchdog,
    // status chrome) the model is the only thing left to wait on.
    const running = fold([
      { type: "inference.start" },
      { type: "tool.start", data: { call: { id: "call_1", name: "grep" } } },
      { type: "tool.start", data: { call: { id: "call_2", name: "bash" } } },
    ]);
    expect(running.activeToolCalls).toHaveLength(2);
    expect(running.awaitingResponse).toBe(false);

    const oneDone = turnStateFromEvent(
      running,
      { type: "tool.done", data: { result: { callId: "call_1" } } },
      200,
    );
    expect(oneDone.activeToolCalls).toHaveLength(1);
    expect(oneDone.awaitingResponse).toBe(false);

    const bothDone = turnStateFromEvent(
      oneDone,
      { type: "tool.done", data: { result: { callId: "call_2" } } },
      201,
    );
    expect(bothDone.activeToolCalls).toHaveLength(0);
    expect(bothDone.awaitingResponse).toBe(true);
  });

  test("a lone tool.done still sets awaitingResponse", () => {
    const running = fold([
      { type: "inference.start" },
      { type: "tool.start", data: { call: { id: "call_1", name: "bash" } } },
    ]);
    const done = turnStateFromEvent(
      running,
      { type: "tool.done", data: { result: { callId: "call_1" } } },
      200,
    );
    expect(done.awaitingResponse).toBe(true);
  });

  test("a second call to the same tool name does not inherit a finished call's id", () => {
    const firstDone = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.start", data: { name: "bash" } },
      { type: "tool.start", data: { call: { id: "call_1", name: "bash" } } },
      { type: "tool.done", data: { result: { callId: "call_1" } } },
    ]);
    expect(firstDone.activeToolCalls).toHaveLength(0);

    const secondRunning = [
      { type: "inference.tool_call.start", data: { name: "bash" } },
      { type: "tool.start", data: { call: { id: "call_2", name: "bash" } } },
    ].reduce((state, event, i) => turnStateFromEvent(state, event, 100 + i), firstDone);
    expect(secondRunning.activeToolCalls).toEqual(["call_2"]);

    const secondDone = turnStateFromEvent(
      secondRunning,
      { type: "tool.done", data: { result: { callId: "call_2" } } },
      200,
    );
    expect(secondDone.activeToolCalls).toHaveLength(0);
  });

  test("reactor.done settles back to idle", () => {
    const s = fold([{ type: "inference.start" }, { type: "reactor.done" }]);
    expect(s.status).toBe("idle");
    expect(s.isProcessing).toBe(false);
  });

  test("inference.done with no active tool calls settles the turn", () => {
    // Regression for CL-5563/CL-5570: a self-continuing workflow cycle
    // may never emit connector.reply, the usual
    // terminator. Without settling here too, isProcessing (and the "working"
    // ramp it drives) stays true forever once nothing else arrives.
    const s = fold([
      { type: "inference.start" },
      { type: "inference.text.delta" },
      { type: "inference.done" },
    ]);
    expect(s.status).toBe("done");
    expect(s.isProcessing).toBe(false);
  });

  test("inference.done with a tool call still outstanding does not settle", () => {
    const s = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.end", data: { name: "bash" } },
      { type: "inference.done" },
    ]);
    expect(s.isProcessing).toBe(true);
    expect(s.status).toBe("running");
  });

  test("activity clock advances with every event", () => {
    const s = fold([{ type: "inference.start" }, { type: "inference.text.delta" }]);
    expect(s.lastActivityAt).toBe(2);
  });

  test("quota_exhausted opens a retry window", () => {
    const s = turnStateFromEvent(
      initialTurnState(0),
      {
        type: "inference.error",
        data: {
          error: { category: "quota_exhausted", retryAfterMs: 60_000 },
        },
      },
      1_000,
    );
    expect(s.quota).toEqual({ retryAfterMs: 60_000, retryAt: 61_000 });
  });

  test("other inference errors open no window", () => {
    const s = turnStateFromEvent(
      initialTurnState(0),
      { type: "inference.error", data: { error: { category: "retryable" } } },
      1_000,
    );
    expect(s.quota).toBeNull();
  });

  test("malformed error payloads are ignored", () => {
    const s = turnStateFromEvent(
      initialTurnState(0),
      { type: "inference.error", data: { error: "boom" } },
      1_000,
    );
    expect(s.quota).toBeNull();
  });

  test("canonical run events drive the same phases", () => {
    expect(fold([{ type: "run", state: "busy" }]).status).toBe("running");
    expect(
      fold([
        { type: "run", state: "busy" },
        { type: "run", state: "idle" },
      ]).status,
    ).toBe("idle");
  });
});

describe("turn transitions", () => {
  test("submit enters the awaiting phase", () => {
    const s = turnStateOnSubmit(initialTurnState(0), 5);
    expect(s).toMatchObject({
      status: "running",
      isProcessing: true,
      awaitingResponse: true,
      lastActivityAt: 5,
    });
  });

  test("interrupt stops and clears the quota window", () => {
    const quota = turnStateFromEvent(
      initialTurnState(0),
      {
        type: "inference.error",
        data: { error: { category: "quota_exhausted", retryAfterMs: 10 } },
      },
      0,
    );
    const s = turnStateOnInterrupt(quota, 9);
    expect(s.status).toBe("stopped");
    expect(s.quota).toBeNull();
    expect(s.isProcessing).toBe(false);
  });

  test("gate blocks without ending the turn", () => {
    const s = turnStateGateOpened(turnStateOnSubmit(initialTurnState(0), 1));
    expect(s.status).toBe("blocked");
    expect(s.isProcessing).toBe(true);
    expect(s.blockedGateCount).toBe(1);
  });

  test("a second queued gate keeps the turn blocked until both clear", () => {
    const running = turnStateOnSubmit(initialTurnState(0), 1);
    const bothOpen = turnStateGateOpened(turnStateGateOpened(running));
    expect(bothOpen.status).toBe("blocked");
    expect(bothOpen.blockedGateCount).toBe(2);

    const oneClosed = turnStateGateClosed(bothOpen, 5);
    expect(oneClosed.status).toBe("blocked");
    expect(oneClosed.blockedGateCount).toBe(1);

    const allClosed = turnStateGateClosed(oneClosed, 9);
    expect(allClosed.status).toBe("running");
    expect(allClosed.blockedGateCount).toBe(0);
    expect(allClosed.lastActivityAt).toBe(9);
  });

  test("a gate still open at interrupt keeps its count into the next turn", () => {
    // The overlay is not closed by an interrupt — nothing else resolves it —
    // so a turn that ends while a gate is still outstanding must not lose
    // count of it: the eventual close belongs to this gate, not to whatever
    // turn happens to be live when the operator finally answers.
    const interrupted = turnStateOnInterrupt(
      turnStateGateOpened(turnStateOnSubmit(initialTurnState(0), 1)),
      2,
    );
    expect(interrupted.status).toBe("stopped");
    expect(interrupted.blockedGateCount).toBe(1);

    const nextTurn = turnStateOnSubmit(interrupted, 3);
    expect(nextTurn.status).toBe("blocked");
    expect(nextTurn.blockedGateCount).toBe(1);

    // The stale gate from before the interrupt finally resolves — it must
    // settle the count the new turn inherited, not resurrect a status the
    // new turn never asked for.
    const resolved = turnStateGateClosed(nextTurn, 9);
    expect(resolved.status).toBe("running");
    expect(resolved.blockedGateCount).toBe(0);
  });

  test("closing a stale gate after the turn settled does not resurrect it", () => {
    const done = turnStateFromEvent(
      turnStateGateOpened(turnStateOnSubmit(initialTurnState(0), 1)),
      { type: "inference.done", data: {} },
      2,
    );
    expect(done.status).toBe("done");
    expect(done.blockedGateCount).toBe(1);

    const resolved = turnStateGateClosed(done, 9);
    expect(resolved.status).toBe("done");
    expect(resolved.blockedGateCount).toBe(0);
  });
});

describe("repetition tracking", () => {
  const line1 = "I'll verify callId emission and remaining edges, then write the ranked findings.";
  const line2 = "Confirming callId emission, then writing the ranked findings.";
  // The captured incident shape: the two sentences run together with no
  // separator, each delta landing as one full cycle.
  const cycle = `${line1}${line2}`;

  const textDelta = (text: string) => ({
    type: "inference.text.delta",
    data: { token: text },
  });

  test("varied streamed text is never flagged", () => {
    const s = fold([
      { type: "inference.start" },
      textDelta("I'll check the callId path.\n"),
      textDelta("Running the search now.\n"),
      textDelta("Found the match.\n"),
    ]);
    expect(s.repeating).toBe(false);
    expect(s.repeatingSinceTokenCount).toBeNull();
  });

  test("a couple of restated cycles across tool calls is not a loop", () => {
    const deltas = Array(3)
      .fill(cycle)
      .map((text) => textDelta(text));
    const s = fold([{ type: "inference.start" }, ...deltas]);
    expect(s.repeating).toBe(false);
  });

  test("the same block repeated every cycle, interleaved with tool calls, still trips as a loop", () => {
    // The gap this closes: an unconditional per-cycle reset (no cross-cycle
    // memory at all) never catches a model that loops while interleaving a
    // trivial tool call between every repeat — verified against a 500-cycle,
    // 88,000-character run that never flipped `repeating`. A fingerprint of
    // each completed cycle, compared to the one before it, catches this
    // shape within a small, bounded number of cycles instead.
    const block = "xk4mQ2 loop unit that never varies at all here";
    expect(block.length).toBeGreaterThanOrEqual(24);

    let state = fold([{ type: "inference.start" }]);
    let clock = 1;
    let trippedAtCycle = -1;
    for (let cycleIndex = 0; cycleIndex < 30; cycleIndex++) {
      state = turnStateFromEvent(state, textDelta(block), ++clock);
      state = turnStateFromEvent(
        state,
        {
          type: "tool.start",
          data: { call: { id: `c${cycleIndex}`, name: "noop" } },
        },
        ++clock,
      );
      state = turnStateFromEvent(state, { type: "connector.reply" }, ++clock);
      state = turnStateFromEvent(
        state,
        { type: "tool.done", data: { result: { callId: `c${cycleIndex}` } } },
        ++clock,
      );
      if (trippedAtCycle === -1 && state.repeating) trippedAtCycle = cycleIndex;
    }
    expect(state.repeating).toBe(true);
    expect(trippedAtCycle).toBeGreaterThan(-1);
    expect(trippedAtCycle).toBeLessThan(30);
  });

  test("a short narration line repeated before each of nine tool calls is not a loop", () => {
    // Verified false positive (CL-5577): "Let me check the next file now."
    // fed in 4-char chunks before nine separate tool calls, interleaved with
    // tool.start/connector.reply/tool.done, must not abort the turn. Nothing
    // about saying a similar short thing before each of several tool calls
    // in one turn is degenerate.
    const narration = "Let me check the next file now.";
    const chunks: string[] = [];
    for (let i = 0; i < narration.length; i += 4) {
      chunks.push(narration.slice(i, i + 4));
    }

    let state = fold([{ type: "inference.start" }]);
    let clock = 1;
    for (let cycleIndex = 0; cycleIndex < 12; cycleIndex++) {
      for (const chunk of chunks) {
        state = turnStateFromEvent(state, textDelta(chunk), ++clock);
      }
      state = turnStateFromEvent(
        state,
        {
          type: "tool.start",
          data: { call: { id: `c${cycleIndex}`, name: "read_file" } },
        },
        ++clock,
      );
      state = turnStateFromEvent(state, { type: "connector.reply" }, ++clock);
      state = turnStateFromEvent(
        state,
        { type: "tool.done", data: { result: { callId: `c${cycleIndex}` } } },
        ++clock,
      );
      expect(state.repeating).toBe(false);
    }
    expect(state.repeating).toBe(false);
  });

  test("a fresh submit clears the repetition state", () => {
    const deltas = Array(10)
      .fill(cycle)
      .map((text) => textDelta(text));
    const looping = fold([{ type: "inference.start" }, ...deltas]);
    const restarted = turnStateOnSubmit(looping, 200);
    expect(restarted.repeating).toBe(false);
    expect(restarted.repeatingSinceTokenCount).toBeNull();
    expect(restarted.streamText).toBe("");
  });
});
