import { describe, expect, test } from "bun:test"

import {
  classifyAgentSendFailure,
  resolveSessionSpinnerLabel,
  shouldSettleUiAfterSendFailure,
} from "./session-chrome.js"

describe("resolveSessionSpinnerLabel", () => {
  test("idle processing off yields no label", () => {
    expect(
      resolveSessionSpinnerLabel({
        isProcessing: false,
        status: "idle",
        awaitingResponse: false,
        currentToolName: null,
        streamingType: null,
      }),
    ).toBeUndefined()
  })

  test("blocked gate shows approval wait", () => {
    expect(
      resolveSessionSpinnerLabel({
        isProcessing: true,
        status: "blocked",
        awaitingResponse: false,
        currentToolName: "run_shell",
        streamingType: "tool",
      }),
    ).toBe("Waiting for approval…")
  })

  test("stopping beats tool phase", () => {
    expect(
      resolveSessionSpinnerLabel({
        isProcessing: true,
        status: "stopping",
        awaitingResponse: false,
        currentToolName: "grep",
        streamingType: "tool",
      }),
    ).toBe("Stopping…")
  })

  test("tool phase beats generic working", () => {
    expect(
      resolveSessionSpinnerLabel({
        isProcessing: true,
        status: "running",
        awaitingResponse: true,
        currentToolName: "grep",
        streamingType: "tool",
      }),
    ).toBe("Running tool…")
  })

  test("thinking and text phases", () => {
    const base = {
      isProcessing: true,
      status: "running" as const,
      awaitingResponse: false,
      currentToolName: null,
    }
    expect(
      resolveSessionSpinnerLabel({ ...base, streamingType: "thinking" }),
    ).toBe("Thinking…")
    expect(resolveSessionSpinnerLabel({ ...base, streamingType: "text" })).toBe(
      "Responding…",
    )
    expect(
      resolveSessionSpinnerLabel({
        ...base,
        awaitingResponse: true,
        streamingType: null,
      }),
    ).toBe("Working…")
  })
})

describe("classifyAgentSendFailure", () => {
  const codex = (e: unknown) => e === "codex"
  const xai = (e: unknown) => e === "xai"

  test("abort is ignored", () => {
    expect(classifyAgentSendFailure(new Error("x"), true, codex, xai)).toBe(
      "abort",
    )
    expect(shouldSettleUiAfterSendFailure("abort")).toBe(false)
  })

  test("generic error settles ui", () => {
    expect(classifyAgentSendFailure(new Error("boom"), false, codex, xai)).toBe(
      "error",
    )
    expect(shouldSettleUiAfterSendFailure("error")).toBe(true)
  })

  test("auth failures settle ui for idle footer", () => {
    expect(classifyAgentSendFailure("codex", false, codex, xai)).toBe(
      "codex_auth",
    )
    expect(classifyAgentSendFailure("xai", false, codex, xai)).toBe("xai_auth")
    expect(shouldSettleUiAfterSendFailure("codex_auth")).toBe(true)
    expect(shouldSettleUiAfterSendFailure("xai_auth")).toBe(true)
  })
})
