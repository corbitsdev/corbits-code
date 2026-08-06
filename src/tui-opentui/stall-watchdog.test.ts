import { describe, expect, test } from "bun:test"

import {
  applyStallRecovery,
  shouldAbortForStall,
  shouldNoticeStall,
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
  }

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
  test("aborts then notifies", () => {
    const calls: string[] = []
    applyStallRecovery({
      abort: () => calls.push("abort"),
      notify: (m) => calls.push(m),
    })
    expect(calls).toEqual(["abort", STALL_RECOVERY_MESSAGE])
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
  }

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
