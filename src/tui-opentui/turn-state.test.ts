import { describe, expect, test } from "bun:test"

import {
  initialTurnState,
  turnStateBlocked,
  turnStateFromEvent,
  turnStateOnInterrupt,
  turnStateOnSubmit,
} from "./turn-state.js"

const fold = (
  events: readonly { type: string; data?: unknown; state?: string }[],
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
