import { test, expect } from "bun:test";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  TokenUsage,
  LastCycleSource,
} from "@intx/types/runtime";
import { createChatDirector } from "../../src/agent/director.js";

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
  sourceId: "test",
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
    infer: () => {
      calls.push("infer");
      return { type: "infer" };
    },
    executeTools: () => {
      calls.push("executeTools");
      return { type: "execute_tools", calls: [] };
    },
    suspend: (gate) => {
      calls.push("suspend");
      return { type: "suspend", gate };
    },
    fork: (mode, forkId) => {
      calls.push("fork");
      return { type: "fork", mode, forkId };
    },
    emit: (eventType, data) => {
      calls.push("emit");
      return { type: "emit", eventType, data };
    },
    reply: (content: string) => {
      calls.push(`reply:${content}`);
      return { type: "reply", content };
    },
    checkpoint: (message = "") => {
      calls.push(`checkpoint:${message}`);
      return { type: "checkpoint", message };
    },
    compact: (compactor, reason) => {
      calls.push("compact");
      return { type: "compact", compactor, reason };
    },
    wait: () => {
      calls.push("wait");
      return { type: "wait" };
    },
    done: () => {
      calls.push("done");
      return { type: "done" };
    },
  };
}

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

// An inference.done whose current-cycle input usage is `inputTokens` (the metric
// the compaction trigger reads), carrying a tool call so the default director
// re-infers on the following tool.done.
function inferenceDoneWithInput(inputTokens: number): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call-1", name: "read_file", arguments: { path: "x.ts" } },
      ],
      model: "test-model",
      timestamp: 0,
    },
    usage: { ...usage, input: inputTokens },
    source,
  };
}

// Enough turns to satisfy the >6 turn guard.
const manyTurnsState: ReactorState = {
  ...state,
  turns: Array.from({ length: 8 }, () => ({
    role: "assistant" as const,
    content: [],
    model: "test-model",
    timestamp: 0,
  })),
};

function makeChatDirectorWithContinuation(onContinue: () => void) {
  return createChatDirector("sys", [], {
    onTasksChange: () => {},
    requestContinuation: onContinue,
  });
}

test("current context over threshold emits compact and a continuation request, not a dead loop", async () => {
  let continuations = 0;
  const director = makeChatDirectorWithContinuation(() => {
    continuations++;
  });

  // A cycle whose input usage exceeds ~60% of the default 128k window arms compaction.
  await director.decide(inferenceDoneWithInput(100_000), manyTurnsState, makeCapabilities());

  // The next tool.done would normally re-infer; instead it compacts and asks
  // the host to re-enter the loop.
  const caps = makeCapabilities();
  const result = await director.decide(toolDoneTurn("call-1"), manyTurnsState, caps);
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

test("compaction is self-regulating: a cycle back under threshold does not re-compact", async () => {
  let continuations = 0;
  const director = makeChatDirectorWithContinuation(() => {
    continuations++;
  });

  // After a compaction truncates history, the next cycle's input usage falls
  // back under the threshold — so no further compaction is armed. This is the
  // behavior that makes a (reload-fragile) cooldown unnecessary.
  await director.decide(inferenceDoneWithInput(5_000), manyTurnsState, makeCapabilities());
  const result = await director.decide(toolDoneTurn("call-1"), manyTurnsState, makeCapabilities());
  const arr = Array.isArray(result) ? result : [result];

  expect(arr.some((a) => a.type === "compact")).toBe(false);
  expect(arr.some((a) => a.type === "infer")).toBe(true);
  expect(continuations).toBe(0);
});

// ---------------------------------------------------------------------------
// Model-family policy / main-session loop protection (CL-5611): a tool-only
// streak must not hard-pause on turn count alone — a Grok session hard-paused
// at 10 turns of real progress (Linear lookups + code reads) motivated
// replacing the count-only pause with a real no-progress signal (identical
// tool-call fingerprint repeating). See src/agent/director.test.ts for the
// full loop-protection coverage; these two cover the regression scenario
// directly against resolveModelFamilyPolicy's grok branch.
// ---------------------------------------------------------------------------

function toolOnlyInferenceDone(callId: string, path = "x.ts"): ReactorInboundEvent {
  return {
    type: "inference.done",
    turn: {
      role: "assistant",
      content: [{ type: "tool_call", id: callId, name: "read_file", arguments: { path } }],
      model: "test-model",
      timestamp: 0,
    },
    usage,
    source,
  };
}

async function runToolOnlyStreak(
  director: ReturnType<typeof createChatDirector>,
  turns: number,
  varyPath = true,
) {
  let lastActions: ReactorAction[] = [];
  for (let i = 0; i < turns; i++) {
    await director.decide(
      toolOnlyInferenceDone(`call-${i}`, varyPath ? `x-${i}.ts` : "x.ts"),
      state,
      makeCapabilities(),
    );
    const result = await director.decide(toolDoneTurn(`call-${i}`), state, makeCapabilities());
    lastActions = Array.isArray(result) ? result : [result];
  }
  return lastActions;
}

test("a grok provider no longer pauses a 10-turn productive tool-only streak", async () => {
  const grokDirector = createChatDirector("sys", [], {
    onTasksChange: () => {},
    provider: { providerName: "xai", model: "grok-4" },
  });
  const grokActions = await runToolOnlyStreak(grokDirector, 10);
  expect(grokActions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
    false,
  );

  const defaultDirector = createChatDirector("sys", [], {
    onTasksChange: () => {},
    provider: { providerName: "openai", model: "gpt-4" },
  });
  const defaultActions = await runToolOnlyStreak(defaultDirector, 10);
  expect(defaultActions.some((a) => a.type === "reply" && a.content.includes("Auto-paused"))).toBe(
    false,
  );
});
