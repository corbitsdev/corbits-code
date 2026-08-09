import { describe, expect, test } from "bun:test"

import {
  applyStallRecovery,
  detectRepetition,
  isStalledForDisplay,
  repetitionRecoveryMessage,
  shouldAbortForStall,
  shouldNoticeStall,
  stallLevel,
  STALL_NOTICE_MS,
  STALL_RECOVERY_MESSAGE,
  STALL_TIMEOUT_MS,
} from "./stall-watchdog.js"

describe("shouldAbortForStall", () => {
  const base = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_TIMEOUT_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    isProcessing: true,
    streamingType: null,
    activeToolCalls: [],
  }

  test("a parallel fan-out with sibling tools still running is not a stall", () => {
    const args = {
      ...base,
      activeToolCalls: ["call-2"],
      lastActivityAt: 0,
      nowMs: 20 * 60_000,
    }
    expect(shouldAbortForStall(args)).toBe(false)
  })

  test("aborts an awaiting run past the timeout", () => {
    expect(shouldAbortForStall(base)).toBe(true)
  })

  test("does not abort before the timeout", () => {
    expect(shouldAbortForStall({ ...base, nowMs: STALL_TIMEOUT_MS - 1 })).toBe(
      false,
    )
  })

  test("only running turns are watched", () => {
    expect(shouldAbortForStall({ ...base, status: "idle" })).toBe(false)
    expect(shouldAbortForStall({ ...base, status: "blocked" })).toBe(false)
    expect(shouldAbortForStall({ ...base, status: "done" })).toBe(false)
    expect(shouldAbortForStall({ ...base, status: "stopping" })).toBe(false)
  })

  // Two independent exemptions (a gate open on the operator, a sibling tool
  // call still outstanding) must both keep exempting when combined — neither
  // one's guard may accidentally require the other's condition to also hold.
  test("a gate open and a sibling tool call each exempt alone, and together", () => {
    const gateOnly = { ...base, status: "blocked" as const }
    const toolCallOnly = { ...base, activeToolCalls: ["call-2"] }
    const both = { ...base, status: "blocked" as const, activeToolCalls: ["call-2"] }

    expect(shouldAbortForStall(gateOnly)).toBe(false)
    expect(shouldAbortForStall(toolCallOnly)).toBe(false)
    expect(shouldAbortForStall(both)).toBe(false)
  })

  test("a settled turn with nothing in flight is not a stall", () => {
    expect(
      shouldAbortForStall({
        ...base,
        awaitingResponse: false,
        isProcessing: false,
      }),
    ).toBe(false)
  })

  test("mid-thinking silence fires, recent thinking tokens do not", () => {
    const thinking = {
      ...base,
      awaitingResponse: false,
      streamingType: "thinking" as const,
    }
    expect(shouldAbortForStall(thinking)).toBe(true)
    expect(
      shouldAbortForStall({ ...thinking, lastActivityAt: STALL_TIMEOUT_MS - 1 }),
    ).toBe(false)
  })

  test("mid-stream text hang aborts", () => {
    expect(
      shouldAbortForStall({
        ...base,
        awaitingResponse: false,
        streamingType: "text",
      }),
    ).toBe(true)
  })

  test("long tool runs are not stalls", () => {
    expect(
      shouldAbortForStall({
        ...base,
        awaitingResponse: false,
        streamingType: "tool",
      }),
    ).toBe(false)
  })
})

describe("applyStallRecovery", () => {
  test("aborts then notifies with the default message", () => {
    const calls: string[] = []
    applyStallRecovery({
      abort: () => calls.push("abort"),
      notify: (m) => calls.push(m),
    })
    expect(calls).toEqual(["abort", STALL_RECOVERY_MESSAGE])
  })

  test("aborts then notifies with a supplied message", () => {
    const calls: string[] = []
    applyStallRecovery(
      { abort: () => calls.push("abort"), notify: (m) => calls.push(m) },
      "custom message",
    )
    expect(calls).toEqual(["abort", "custom message"])
  })
})

describe("detectRepetition", () => {
  test("finds nothing in fresh, varied output", () => {
    const text = [
      "I'll check the callId emission path first.",
      "Running the search now.",
      "Found three matches across the module.",
    ].join("\n")
    expect(detectRepetition(text).repeating).toBe(false)
  })

  // The captured incident: the two sentences ran together with no line break
  // at all. A line-splitting detector never sees this; the period search
  // does not care where (or whether) the lines break.
  test("flags the captured incident string verbatim, with no newlines", () => {
    const line1 =
      "I'll verify callId emission and remaining edges, then write the ranked findings."
    const line2 = "Confirming callId emission, then writing the ranked findings."
    const text = Array(10).fill(`${line1}${line2}`).join("")
    const check = detectRepetition(text)
    expect(check.repeating).toBe(true)
    expect(check.period).toBe(line1.length + line2.length)
  })

  test("does not flag the same cycle a handful of times", () => {
    const line1 =
      "I'll verify callId emission and remaining edges, then write the ranked findings."
    const line2 = "Confirming callId emission, then writing the ranked findings."
    // Fewer than the occurrence threshold: a model can legitimately restate
    // a step once or twice across tool-call cycles without looping.
    const text = Array(4).fill(`${line1}${line2}`).join("")
    expect(detectRepetition(text).repeating).toBe(false)
  })

  test("does not flag a repeated markdown table separator row", () => {
    const row = "| ---------------------- | ---------------------- |"
    const text = Array(6).fill(row).join("\n")
    expect(detectRepetition(text).repeating).toBe(false)
  })

  test("does not flag a few identical code lines", () => {
    const line = "  const result = await fetchData(request, options, context)"
    const text = Array(3).fill(line).join("\n")
    expect(detectRepetition(text).repeating).toBe(false)
  })

  test("ignores short recurring fragments", () => {
    const text = Array(10).fill("ok").join(" ")
    expect(detectRepetition(text).repeating).toBe(false)
  })

  // A monochrome run is periodic at every period by construction — the
  // easiest thing to false-trigger on if entropy is not checked.
  test("does not flag a long run of the same character", () => {
    expect(detectRepetition("x".repeat(500)).repeating).toBe(false)
  })

  test("does not flag a repeated horizontal rule", () => {
    const text = Array(10).fill("----------------------------").join("\n")
    expect(detectRepetition(text).repeating).toBe(false)
  })
})

describe("repetitionRecoveryMessage", () => {
  test("names degeneration and attributes the looped tokens", () => {
    const message = repetitionRecoveryMessage(42)
    expect(message).toContain("repeating itself")
    expect(message).toContain("42")
  })
})

describe("shouldNoticeStall", () => {
  const base = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_NOTICE_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    stallNoticeMs: STALL_NOTICE_MS,
    isProcessing: true,
    streamingType: null,
    repeating: false,
    activeToolCalls: [],
  }

  test("a parallel fan-out with sibling tools still running does not notice", () => {
    expect(
      shouldNoticeStall({ ...base, activeToolCalls: ["call-2"] }),
    ).toBe(false)
  })

  test("stays quiet while repeating, even if also silent by the clock", () => {
    expect(shouldNoticeStall({ ...base, repeating: true })).toBe(false)
  })

  test("speaks up long before the abort backstop", () => {
    expect(STALL_NOTICE_MS).toBeLessThan(STALL_TIMEOUT_MS)
    expect(shouldNoticeStall(base)).toBe(true)
    expect(shouldAbortForStall(base)).toBe(false)
  })

  test("stays quiet before the notice threshold", () => {
    expect(shouldNoticeStall({ ...base, nowMs: STALL_NOTICE_MS - 1 })).toBe(false)
  })

  test("hands over to the abort once the run is aborted", () => {
    expect(shouldNoticeStall({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe(false)
  })

  test("a long tool run is not stuck", () => {
    expect(
      shouldNoticeStall({
        ...base,
        awaitingResponse: false,
        streamingType: "tool",
      }),
    ).toBe(false)
  })
})

describe("the stall level the indicator reads", () => {
  const base = {
    status: "running" as const,
    awaitingResponse: true,
    lastActivityAt: 0,
    nowMs: STALL_NOTICE_MS,
    stallTimeoutMs: STALL_TIMEOUT_MS,
    stallNoticeMs: STALL_NOTICE_MS,
    isProcessing: true,
    streamingType: null,
    activeToolCalls: [],
    repeating: false,
  }

  test("quiet, notice and abort partition the same silence clock", () => {
    expect(stallLevel({ ...base, nowMs: STALL_NOTICE_MS - 1 })).toBe("quiet")
    expect(stallLevel({ ...base, nowMs: STALL_NOTICE_MS })).toBe("notice")
    expect(stallLevel({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe("abort")
  })

  test("the indicator keeps reading stalled across the abort threshold", () => {
    // The notice hands over to the abort so the two never speak at once, but
    // the phase must not flip back to healthy at the exact moment the run is
    // most stuck — that was the whole complaint the indicator answers.
    expect(shouldNoticeStall({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe(false)
    expect(isStalledForDisplay({ ...base, nowMs: STALL_TIMEOUT_MS })).toBe(true)
    expect(isStalledForDisplay({ ...base, nowMs: STALL_TIMEOUT_MS * 3 })).toBe(
      true,
    )
  })

  test("a repeating run is not a stall on any surface", () => {
    const looping = { ...base, nowMs: STALL_TIMEOUT_MS, repeating: true }
    expect(stallLevel(looping)).toBe("quiet")
    expect(isStalledForDisplay(looping)).toBe(false)
  })
})
