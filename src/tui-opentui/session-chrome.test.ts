import { describe, expect, test } from "bun:test"

import {
  ACTIVITY_STATES,
  classifyAgentSendFailure,
  classifySendFailureMessage,
  resolveRampPhase,
  resolveTurnLabel,
  sendFailureText,
  shouldSettleUiAfterSendFailure,
} from "./session-chrome.js"

// The load-bearing guarantee: whatever tool identifier, MCP server name, or
// plugin name the runtime hands us, the rendered ticker string must land in
// the small closed set of human activity states — never the raw identifier.
// A previously-unmapped tool (or one this test doesn't enumerate) must still
// fall back into the set rather than leaking through verbatim.
describe("resolveTurnLabel closed-set guarantee", () => {
  const leakingIdentifiers = [
    "run_shell",
    "grep",
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
    "list_dir",
    "web_search",
    "web_fetch",
    "manage_tasks",
    "task",
    "submit_output",
    "ask_operator",
    "mcp__glitchtip__authenticate",
    "mcp__railway__deploy",
    "some_未knownしplugin_tool",
    "a-plugin-defined-tool-name",
    "totally_unmapped_future_tool",
  ]

  for (const currentToolName of leakingIdentifiers) {
    test(`"${currentToolName}" resolves to a member of the closed set`, () => {
      const label = resolveTurnLabel(
        {
          isProcessing: true,
          status: "running",
          currentToolName,
          streamingType: "tool",
        },
        false,
      )
      expect(label).not.toBe(currentToolName)
      expect(ACTIVITY_STATES).toContain(label!)
    })
  }

  test("a stalled turn renders a distinct stalled state", () => {
    const label = resolveTurnLabel(
      {
        isProcessing: true,
        status: "running",
        currentToolName: "run_shell",
        streamingType: "tool",
      },
      true,
    )
    expect(label).toBe("stalled")
    expect(ACTIVITY_STATES).toContain(label!)
  })

  test("waiting on the operator is distinguishable from working", () => {
    const label = resolveTurnLabel(
      {
        isProcessing: true,
        status: "blocked",
        currentToolName: "run_shell",
        streamingType: "tool",
      },
      false,
    )
    expect(label).toBe("waiting")
    expect(label).not.toBe("working")
    expect(ACTIVITY_STATES).toContain(label!)
  })
})

describe("resolveTurnLabel", () => {
  test("idle processing off yields no label", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: false,
          status: "idle",
          currentToolName: null,
          streamingType: null,
        },
        false,
      ),
    ).toBeUndefined()
  })

  test("blocked gate shows a waiting-on-operator state", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: true,
          status: "blocked",
          currentToolName: "run_shell",
          streamingType: "tool",
        },
        false,
      ),
    ).toBe("waiting")
  })

  test("stopping beats tool phase", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: true,
          status: "stopping",
          currentToolName: "grep",
          streamingType: "tool",
        },
        false,
      ),
    ).toBe("stopping")
  })

  test("tool phase maps to its semantic activity, never the raw name", () => {
    expect(
      resolveTurnLabel(
        {
          isProcessing: true,
          status: "running",
          currentToolName: "grep",
          streamingType: "tool",
        },
        false,
      ),
    ).toBe("researching")
  })

  test("thinking and text phases", () => {
    const base = {
      isProcessing: true,
      status: "running" as const,
      currentToolName: null,
    }
    expect(
      resolveTurnLabel({ ...base, streamingType: "thinking" }, false),
    ).toBe("thinking")
    expect(
      resolveTurnLabel({ ...base, streamingType: "text" }, false),
    ).toBe("working")
    expect(
      resolveTurnLabel({ ...base, streamingType: null }, false),
    ).toBe("working")
  })
})

describe("resolveRampPhase", () => {
  const base = {
    isProcessing: true,
    currentToolName: null,
    streamingType: null,
  }

  test("blocked gate freezes the ramp", () => {
    expect(resolveRampPhase({ ...base, status: "blocked" }, false)).toBe("blocked")
  })

  test("done fills the ramp", () => {
    expect(resolveRampPhase({ ...base, status: "done" }, false)).toBe("done")
  })

  test("everything else is working", () => {
    expect(resolveRampPhase({ ...base, status: "running" }, false)).toBe("working")
    expect(resolveRampPhase({ ...base, status: "stopping" }, false)).toBe("working")
  })

  test("a stalled running turn paints stalled, not working", () => {
    expect(
      resolveRampPhase({ ...base, status: "running" }, true),
    ).toBe("stalled")
  })

  test("a blocked gate beats stalled — waiting on you outranks silence", () => {
    expect(
      resolveRampPhase({ ...base, status: "blocked" }, true),
    ).toBe("blocked")
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
