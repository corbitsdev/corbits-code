import { describe, expect, test } from "bun:test"

import {
  classifyAgentSendFailure,
  classifySendFailureMessage,
  resolveRampPhase,
  resolveTurnLabel,
  sendFailureText,
  shouldSettleUiAfterSendFailure,
} from "./session-chrome.js"

describe("resolveTurnLabel", () => {
  test("idle processing off yields no label", () => {
    expect(
      resolveTurnLabel({
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
      resolveTurnLabel({
        isProcessing: true,
        status: "blocked",
        awaitingResponse: false,
        currentToolName: "run_shell",
        streamingType: "tool",
      }),
    ).toBe("blocked")
  })

  test("stopping beats tool phase", () => {
    expect(
      resolveTurnLabel({
        isProcessing: true,
        status: "stopping",
        awaitingResponse: false,
        currentToolName: "grep",
        streamingType: "tool",
      }),
    ).toBe("stopping")
  })

  test("tool phase beats generic working", () => {
    expect(
      resolveTurnLabel({
        isProcessing: true,
        status: "running",
        awaitingResponse: true,
        currentToolName: "grep",
        streamingType: "tool",
      }),
    ).toBe("grep")
  })

  test("thinking and text phases", () => {
    const base = {
      isProcessing: true,
      status: "running" as const,
      awaitingResponse: false,
      currentToolName: null,
    }
    expect(
      resolveTurnLabel({ ...base, streamingType: "thinking" }),
    ).toBe("thinking")
    expect(
      resolveTurnLabel({ ...base, streamingType: "text", streamTokenCount: 7 }),
    ).toBe("streaming 7 tok")
    expect(
      resolveTurnLabel({
        ...base,
        awaitingResponse: true,
        streamingType: null,
      }),
    ).toBe("working")
  })

  test("text phase with no count yet reads zero", () => {
    expect(
      resolveTurnLabel({
        isProcessing: true,
        status: "running",
        awaitingResponse: false,
        currentToolName: null,
        streamingType: "text",
      }),
    ).toBe("streaming 0 tok")
  })
})

describe("resolveRampPhase", () => {
  const base = {
    isProcessing: true,
    awaitingResponse: false,
    currentToolName: null,
    streamingType: null,
  }

  test("blocked gate freezes the ramp", () => {
    expect(resolveRampPhase({ ...base, status: "blocked" })).toBe("blocked")
  })

  test("done fills the ramp", () => {
    expect(resolveRampPhase({ ...base, status: "done" })).toBe("done")
  })

  test("everything else is working", () => {
    expect(resolveRampPhase({ ...base, status: "running" })).toBe("working")
    expect(resolveRampPhase({ ...base, status: "stopping" })).toBe("working")
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

describe("sendFailureText", () => {
  test("an expired subscription sign-in says what to press", () => {
    const codex = sendFailureText(
      'Codex profile "default" is not authorized. Log in again.',
    )
    expect(classifySendFailureMessage(
      'Codex profile "default" is not authorized. Log in again.',
    )).toBe("codex_auth")
    expect(codex).toContain("sign-in expired")
    expect(codex).toContain("/model")

    const xai = sendFailureText('xAI profile "default" could not be refreshed (401).')
    expect(xai).toContain("/model")
    expect(xai).not.toContain("401")
  })

  test("an unclassified failure keeps its raw message", () => {
    expect(sendFailureText("connection reset by peer")).toBe(
      "connection reset by peer",
    )
    expect(classifySendFailureMessage("connection reset by peer")).toBe("error")
  })
})
