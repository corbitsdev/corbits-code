import { describe, expect, test } from "bun:test"

import {
  initialTurnState,
  turnStateBlocked,
  turnStateFromEvent,
  turnStateOnInterrupt,
  turnStateOnSubmit,
} from "./turn-state.js"

const fold = (
  events: readonly {
    type: string
    data?: unknown
    state?: string
    text?: string
  }[],
  startMs = 0,
) =>
  events.reduce(
    (state, event, i) => turnStateFromEvent(state, event, startMs + i + 1),
    initialTurnState(startMs),
  )

describe("turnStateFromEvent", () => {
  test("start awaits the first token", () => {
    const s = fold([{ type: "inference.start" }])
    expect(s.status).toBe("running")
    expect(s.awaitingResponse).toBe(true)
    expect(s.streamingType).toBeNull()
  })

  test("text and thinking deltas set the streaming phase", () => {
    expect(
      fold([{ type: "inference.start" }, { type: "inference.text.delta" }])
        .streamingType,
    ).toBe("text")
    expect(
      fold([{ type: "inference.start" }, { type: "inference.thinking.delta" }])
        .streamingType,
    ).toBe("thinking")
  })

  test("text deltas accumulate a live token count, thinking deltas do not", () => {
    const s = fold([
      { type: "inference.start" },
      { type: "inference.text.delta" },
      { type: "inference.text.delta" },
      { type: "inference.thinking.delta" },
    ])
    expect(s.streamTokenCount).toBe(2)
  })

  test("a new submit resets the token count", () => {
    const midTurn = fold([
      { type: "inference.start" },
      { type: "inference.text.delta" },
    ])
    expect(midTurn.streamTokenCount).toBe(1)
    const next = turnStateOnSubmit(midTurn, 10)
    expect(next.streamTokenCount).toBe(0)
  })

  test("tool call tracks the current tool and clears on result", () => {
    const running = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.end", data: { name: "bash" } },
    ])
    expect(running.streamingType).toBe("tool")
    expect(running.currentToolName).toBe("bash")

    const done = turnStateFromEvent(running, { type: "tool.done" }, 100)
    expect(done.currentToolName).toBeNull()
    expect(done.awaitingResponse).toBe(true)
  })

  test("tool.start reads the nested call name", () => {
    expect(
      fold([{ type: "tool.start", data: { call: { name: "grep" } } }])
        .currentToolName,
    ).toBe("grep")
  })

  test("reactor.done settles back to idle", () => {
    const s = fold([{ type: "inference.start" }, { type: "reactor.done" }])
    expect(s.status).toBe("idle")
    expect(s.isProcessing).toBe(false)
  })

  test("inference.done with no active tool calls settles the turn", () => {
    // Regression for CL-5563/CL-5570: a workflow/goal-governor cycle that
    // keeps self-continuing may never emit connector.reply, the usual
    // terminator. Without settling here too, isProcessing (and the "working"
    // ramp it drives) stays true forever once nothing else arrives.
    const s = fold([
      { type: "inference.start" },
      { type: "inference.text.delta" },
      { type: "inference.done" },
    ])
    expect(s.status).toBe("done")
    expect(s.isProcessing).toBe(false)
  })

  test("inference.done with a tool call still outstanding does not settle", () => {
    const s = fold([
      { type: "inference.start" },
      { type: "inference.tool_call.end", data: { name: "bash" } },
      { type: "inference.done" },
    ])
    expect(s.isProcessing).toBe(true)
    expect(s.status).toBe("running")
  })

  test("activity clock advances with every event", () => {
    const s = fold([{ type: "inference.start" }, { type: "inference.text.delta" }])
    expect(s.lastActivityAt).toBe(2)
  })

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
    )
    expect(s.quota).toEqual({ retryAfterMs: 60_000, retryAt: 61_000 })
  })

  test("other inference errors open no window", () => {
    const s = turnStateFromEvent(
      initialTurnState(0),
      { type: "inference.error", data: { error: { category: "retryable" } } },
      1_000,
    )
    expect(s.quota).toBeNull()
  })

  test("malformed error payloads are ignored", () => {
    const s = turnStateFromEvent(
      initialTurnState(0),
      { type: "inference.error", data: { error: "boom" } },
      1_000,
    )
    expect(s.quota).toBeNull()
  })

  test("canonical run events drive the same phases", () => {
    expect(fold([{ type: "run", state: "busy" }]).status).toBe("running")
    expect(
      fold([{ type: "run", state: "busy" }, { type: "run", state: "idle" }])
        .status,
    ).toBe("idle")
  })
})

describe("turn transitions", () => {
  test("submit enters the awaiting phase", () => {
    const s = turnStateOnSubmit(initialTurnState(0), 5)
    expect(s).toMatchObject({
      status: "running",
      isProcessing: true,
      awaitingResponse: true,
      lastActivityAt: 5,
    })
  })

  test("interrupt stops and clears the quota window", () => {
    const quota = turnStateFromEvent(
      initialTurnState(0),
      {
        type: "inference.error",
        data: { error: { category: "quota_exhausted", retryAfterMs: 10 } },
      },
      0,
    )
    const s = turnStateOnInterrupt(quota, 9)
    expect(s.status).toBe("stopped")
    expect(s.quota).toBeNull()
    expect(s.isProcessing).toBe(false)
  })

  test("gate blocks without ending the turn", () => {
    const s = turnStateBlocked(turnStateOnSubmit(initialTurnState(0), 1))
    expect(s.status).toBe("blocked")
    expect(s.isProcessing).toBe(true)
  })
})

describe("repetition tracking", () => {
  const line1 =
    "I'll verify callId emission and remaining edges, then write the ranked findings."
  const line2 = "Confirming callId emission, then writing the ranked findings."
  // The captured incident shape: the two sentences run together with no
  // separator, each delta landing as one full cycle.
  const cycle = `${line1}${line2}`

  const textDelta = (text: string) => ({
    type: "inference.text.delta",
    data: { token: text },
  })

  test("varied streamed text is never flagged", () => {
    const s = fold([
      { type: "inference.start" },
      textDelta("I'll check the callId path.\n"),
      textDelta("Running the search now.\n"),
      textDelta("Found the match.\n"),
    ])
    expect(s.repeating).toBe(false)
    expect(s.repeatingSinceTokenCount).toBeNull()
  })

  test("the captured incident shape (no separator between cycles) flips repeating", () => {
    const deltas = Array(10)
      .fill(cycle)
      .map((text) => textDelta(text))
    const s = fold([{ type: "inference.start" }, ...deltas])
    expect(s.repeating).toBe(true)
    expect(s.repeatingSinceTokenCount).not.toBeNull()
  })

  test("a couple of restated cycles across tool calls is not a loop", () => {
    const deltas = Array(3)
      .fill(cycle)
      .map((text) => textDelta(text))
    const s = fold([{ type: "inference.start" }, ...deltas])
    expect(s.repeating).toBe(false)
  })

  test("repetition tracked across a tool cycle survives connector.reply with tools outstanding", () => {
    const deltas = Array(10)
      .fill(cycle)
      .map((text) => textDelta(text))
    const withTool = turnStateFromEvent(
      fold([{ type: "inference.start" }, ...deltas]),
      { type: "tool.start", data: { call: { id: "c1", name: "grep" } } },
      100,
    )
    const afterReply = turnStateFromEvent(
      withTool,
      { type: "connector.reply" },
      101,
    )
    expect(afterReply.repeating).toBe(true)
    expect(afterReply.streamText.length).toBeGreaterThan(0)
  })

  test("a fresh submit clears the repetition state", () => {
    const deltas = Array(10)
      .fill(cycle)
      .map((text) => textDelta(text))
    const looping = fold([{ type: "inference.start" }, ...deltas])
    const restarted = turnStateOnSubmit(looping, 200)
    expect(restarted.repeating).toBe(false)
    expect(restarted.repeatingSinceTokenCount).toBeNull()
    expect(restarted.streamText).toBe("")
  })
})
