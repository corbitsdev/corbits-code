import { test, expect } from "bun:test";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  TokenUsage,
  LastCycleSource,
} from "@intx/types/runtime";
import { createCodingDirector, createChatDirector } from "../../src/agent/director.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const usage: TokenUsage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

const source: LastCycleSource = {
  id: "test",
  provider: "openai",
  model: "test-model",
};

const state: ReactorState = {
  turns: [],
  activeForks: [],
  pendingOperations: [],
  activeGates: [],
  tokenUsage: usage,
  lastCycleUsage: null,
  lastCycleSource: null,
  sessionId: "test-session",
};

// Tracks which capability methods were called so tests can inspect actions.
function makeCapabilities(): ReactorCapabilities & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    infer: () => { calls.push("infer"); return { type: "infer" }; },
    executeTools: () => { calls.push("executeTools"); return { type: "execute_tools", calls: [] }; },
    suspend: (gate) => { calls.push("suspend"); return { type: "suspend", gate }; },
    fork: (mode, forkId) => { calls.push("fork"); return { type: "fork", mode, forkId }; },
    emit: (eventType, data) => { calls.push("emit"); return { type: "emit", eventType, data }; },
    reply: (content: string) => { calls.push(`reply:${content}`); return { type: "reply", content }; },
    checkpoint: (message = "") => { calls.push(`checkpoint:${message}`); return { type: "checkpoint", message }; },
    compact: (compactor, reason) => { calls.push("compact"); return { type: "compact", compactor, reason }; },
    wait: () => { calls.push("wait"); return { type: "wait" }; },
    done: () => { calls.push("done"); return { type: "done" }; },
  };
}

function idleTurn(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: { role: "assistant", content: [], model: "test-model", timestamp: 0 },
    usage,
    source,
  };
}

function activeTurn(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "x.ts" } }],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source,
  };
}

function hasDone(actions: ReactorAction | ReactorAction[]): boolean {
  const arr = Array.isArray(actions) ? actions : [actions];
  return arr.some((a) => a.type === "done");
}

// ---------------------------------------------------------------------------
// Idle-cycle guard
// ---------------------------------------------------------------------------

test("two consecutive idle turns do not abort", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);
  const caps = makeCapabilities();

  const r1 = await director.decide(idleTurn(), state, caps);
  expect(hasDone(r1)).toBe(false);

  const r2 = await director.decide(idleTurn(), state, caps);
  expect(hasDone(r2)).toBe(false);
});

test("third consecutive idle turn aborts with stall message", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);
  const caps = makeCapabilities();

  await director.decide(idleTurn(), state, caps);
  await director.decide(idleTurn(), state, caps);
  const result = await director.decide(idleTurn(), state, caps);

  expect(hasDone(result)).toBe(true);
  const arr = Array.isArray(result) ? result : [result];
  const reply = arr.find((a): a is { type: "reply"; content: string } => a.type === "reply");
  expect(reply?.content).toContain("stalled");
});

test("a tool-call turn resets the idle counter so two idle after it do not abort", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);
  const caps = makeCapabilities();

  // Two idle turns…
  await director.decide(idleTurn(), state, caps);
  await director.decide(idleTurn(), state, caps);

  // …then a turn with tool calls resets the counter.
  const resetResult = await director.decide(activeTurn(), state, caps);
  expect(hasDone(resetResult)).toBe(false);

  // Two idle turns again — still no abort (counter restarted at 0).
  const r1 = await director.decide(idleTurn(), state, caps);
  expect(hasDone(r1)).toBe(false);

  const r2 = await director.decide(idleTurn(), state, caps);
  expect(hasDone(r2)).toBe(false);
});

// ---------------------------------------------------------------------------
// maxTurns ceiling
// ---------------------------------------------------------------------------

test("turns strictly before maxTurns do not trigger the ceiling", async () => {
  const maxTurns = 5;
  const director = createCodingDirector("sys", [], undefined, maxTurns);

  // Drive maxTurns - 1 active turns (so idle counter stays at 0, avoiding the
  // stall guard which would fire at turn 3 with idle turns).
  for (let i = 0; i < maxTurns - 1; i++) {
    const caps = makeCapabilities();
    const result = await director.decide(activeTurn(), state, caps);
    expect(hasDone(result)).toBe(false);
  }
});

test("the maxTurns-th turn fires the ceiling — not one early, not one late", async () => {
  const maxTurns = 5;
  const director = createCodingDirector("sys", [], undefined, maxTurns);

  for (let i = 0; i < maxTurns - 1; i++) {
    const caps = makeCapabilities();
    const result = await director.decide(activeTurn(), state, caps);
    expect(hasDone(result)).toBe(false);
  }

  // Exactly the maxTurns-th turn.
  const caps = makeCapabilities();
  const result = await director.decide(activeTurn(), state, caps);

  expect(hasDone(result)).toBe(true);
  const arr = Array.isArray(result) ? result : [result];
  const reply = arr.find((a): a is { type: "reply"; content: string } => a.type === "reply");
  expect(reply?.content).toContain(`${maxTurns}`);
});

// ---------------------------------------------------------------------------
// No double-fire after done() has been emitted
// ---------------------------------------------------------------------------

test("a subsequent event after maxTurns done does not emit a second done()", async () => {
  // Use maxTurns = 1 so the ceiling fires on the very first turn.
  const director = createCodingDirector("sys", [], undefined, 1);

  const caps1 = makeCapabilities();
  const first = await director.decide(activeTurn(), state, caps1);
  expect(hasDone(first)).toBe(true);

  // A second inference.done should NOT produce another done action.
  const caps2 = makeCapabilities();
  const second = await director.decide(activeTurn(), state, caps2);
  expect(hasDone(second)).toBe(false);
});

test("a subsequent event after idle-abort done does not emit a second done()", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);

  // Drive to stall.
  await director.decide(idleTurn(), state, makeCapabilities());
  await director.decide(idleTurn(), state, makeCapabilities());
  const stall = await director.decide(idleTurn(), state, makeCapabilities());
  expect(hasDone(stall)).toBe(true);

  // Further event must not produce another done.
  const caps = makeCapabilities();
  const after = await director.decide(idleTurn(), state, caps);
  expect(hasDone(after)).toBe(false);
});

function submitCallTurn(): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [{ type: "tool_call", id: "call-submit", name: "submit_output", arguments: { result: "done" } }],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source,
  };
}

function submitToolDone(): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId: "call-submit", content: "ok", isError: false },
  } as unknown as ReactorInboundEvent;
}

test("submit_output success then a final no-tool-call turn terminates the run", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);
  await director.decide(submitCallTurn(), state, makeCapabilities());
  await director.decide(submitToolDone(), state, makeCapabilities());
  const result = await director.decide(idleTurn(), state, makeCapabilities());
  // submit_output is the clean termination signal; it must emit done(), not
  // leave the loop running until the maxTurns backstop.
  expect(hasDone(result)).toBe(true);
});

test("no further action is emitted after a submit-accepted termination", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);
  await director.decide(submitCallTurn(), state, makeCapabilities());
  await director.decide(submitToolDone(), state, makeCapabilities());
  await director.decide(idleTurn(), state, makeCapabilities());
  const caps = makeCapabilities();
  const after = await director.decide(idleTurn(), state, caps);
  expect(hasDone(after)).toBe(false);
  expect(after).toEqual([]);
});

test("setState restores the terminated guard so a resumed terminal run stays terminal", async () => {
  const director = createCodingDirector("sys", [], undefined, 100);
  await director.decide(idleTurn(), state, makeCapabilities());
  await director.decide(idleTurn(), state, makeCapabilities());
  await director.decide(idleTurn(), state, makeCapabilities());
  const saved = director.getState();

  const resumed = createCodingDirector("sys", [], saved, 100);
  const caps = makeCapabilities();
  const after = await resumed.decide(idleTurn(), state, caps);
  expect(after).toEqual([]);
});

// ---------------------------------------------------------------------------
// Chat director compaction: a compact cycle must not strand the reactor loop.
// The reactor delivers no event after compact, so the director self-delivers an
// empty message (requestContinuation) and infers on the next message.received.
// ---------------------------------------------------------------------------

function toolDoneTurn(callId: string): ReactorInboundEvent {
  return {
    type: "tool.done",
    result: { callId, content: "ok", isError: false },
  } as ReactorInboundEvent;
}

function emptyMessageReceived(): ReactorInboundEvent {
  return {
    type: "message.received",
    message: { content: "" },
  } as ReactorInboundEvent;
}

// State whose cumulative input tokens are over the 80k compaction threshold,
// with enough turns to satisfy the >6 turn guard.
const overThresholdState: ReactorState = {
  ...state,
  turns: Array.from({ length: 8 }, () => ({
    role: "assistant" as const,
    content: [],
    model: "test-model",
    timestamp: 0,
  })),
  tokenUsage: { ...usage, input: 100_000 },
};

test("crossing the token threshold emits compact and a continuation request, not a dead loop", async () => {
  let continuations = 0;
  const director = createChatDirector(
    "sys",
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => { continuations++; },
  );

  // inference.done over the threshold arms compaction.
  await director.decide(activeTurn(), overThresholdState, makeCapabilities());

  // The next tool.done would normally re-infer; instead it compacts and asks
  // the host to re-enter the loop.
  const caps = makeCapabilities();
  const result = await director.decide(toolDoneTurn("call-1"), overThresholdState, caps);
  const arr = Array.isArray(result) ? result : [result];

  expect(arr.some((a) => a.type === "compact")).toBe(true);
  expect(arr.some((a) => a.type === "infer")).toBe(false);
  expect(continuations).toBe(1);

  // The self-delivered empty message resumes inference against truncated history.
  const resumeCaps = makeCapabilities();
  const resume = await director.decide(emptyMessageReceived(), state, resumeCaps);
  const resumeArr = Array.isArray(resume) ? resume : [resume];
  expect(resumeArr.some((a) => a.type === "infer")).toBe(true);
});
