import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"

import type { KeyEvent } from "@opentui/core"

import type { CostSummary } from "../cost/cost-summary.js"
import type { SubAgentSession } from "../subagent/session-store.js"
import { createHarness } from "./harness.js"
import { closeInsetOverlay, runOverlayAction } from "./shell.js"
import {
  mountRunnerHost,
  observeSessionFromSubAgents,
  rowFromTranscriptEntry,
} from "./runner-host.js"

/** The bottom rule holds StyledText; join its chunks for assertions. */
function ruleOf(rule: { content: unknown }): string {
  const content = rule.content
  if (typeof content === "string") return content
  const { chunks } = content as { chunks?: readonly { text?: string }[] }
  return (chunks ?? []).map((c) => c.text ?? "").join("")
}

function fakeCostSummary(): CostSummary {
  return {
    modelId: "opus",
    pricingCache: null,
    totalCost: 0.42,
    formattedCost: "$0.42",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    contextTokens: 1000,
    contextIsEstimate: false,
    costHiddenReason: null,
    contextWindow: 10000,
    contextPercentUsed: 10,
  }
}

function session(over: Partial<SubAgentSession>): SubAgentSession {
  return {
    id: "s1",
    description: "explore callers",
    agentId: "explore",
    brief: "",
    status: "running",
    toolNames: [],
    currentToolName: null,
    entries: [],
    startedAt: 0,
    ...over,
  }
}

describe("rowFromTranscriptEntry", () => {
  test("maps each entry kind onto a stream row", () => {
    expect(rowFromTranscriptEntry({ kind: "text", content: "hi" })).toEqual({
      role: "assistant",
      text: "hi",
    })
    expect(rowFromTranscriptEntry({ kind: "thinking", content: "hm" })).toEqual({
      role: "system",
      text: "hm",
      meta: "thinking",
    })
    expect(
      rowFromTranscriptEntry({ kind: "tool", callId: "c", name: "grep", arguments: "{}" }),
    ).toEqual({
      role: "tool",
      text: "{}",
      meta: "grep",
      verb: "Grep",
      pending: true,
      callKey: "grep Grep ",
      callId: "c",
    })
    expect(
      rowFromTranscriptEntry({
        kind: "tool_result",
        callId: "c",
        name: "grep",
        content: "boom",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "boom", meta: "grep", failed: true, callId: "c" })
    expect(rowFromTranscriptEntry({ kind: "report", content: "done" })).toEqual({
      role: "assistant",
      text: "done",
      meta: "report",
    })
  })
})

describe("observeSessionFromSubAgents", () => {
  test("returns null with no sessions", () => {
    expect(observeSessionFromSubAgents([])).toBeNull()
  })

  test("prefers the newest running session", () => {
    const observed = observeSessionFromSubAgents([
      session({ id: "old", status: "running" }),
      session({ id: "newest", status: "running", agentId: "build" }),
      session({ id: "finished", status: "done" }),
    ])
    expect(observed?.sessionId).toBe("newest")
    expect(observed?.agentId).toBe("build")
  })

  test("falls back to the most recent session when none run", () => {
    const observed = observeSessionFromSubAgents([
      session({ id: "a", status: "done" }),
      session({
        id: "b",
        status: "failed",
        entries: [{ kind: "text", content: "partial" }],
      }),
    ])
    expect(observed?.sessionId).toBe("b")
    expect(observed?.lines).toEqual([{ role: "assistant", text: "partial" }])
  })
})

describe("mountRunnerHost command surfaces", () => {
  test("routes settings and models, and reports surfaces with no data source", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ goal: null, agents: [] }),
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      surfaces: {
        settings: {
          read: () => ({
            compactionMode: "llm",
            sessionMode: "orchestrator",
            sessionModeScope: "global",
            maxConcurrentSubAgents: 3,
            waitForApproval: true,
            telemetryEnabled: false,
            showPromptCost: false,
          }),
          setCompactionMode: () => {},
          setSessionMode: () => {},
          setMaxConcurrentSubAgents: () => {},
          setWaitForApproval: () => {},
          setTelemetryEnabled: () => {},
          setShowPromptCost: () => {},
        },
      },
    })
    try {
      expect(host.openSurface("settings")).toBe(true)
      expect(host.shell.overlayKind).toBe("settings")
      closeInsetOverlay(host.shell)
      // onModelSelect is wired even with an empty catalog, since the "not
      // connected" section can populate the picker on its own.
      expect(host.openSurface("models")).toBe(true)
    } finally {
      host.dispose()
      harness.destroy()
    }
  })
})

describe("mountRunnerHost model picker", () => {
  test("lists a connect row for each unconnected provider, described in the connect copy", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4"] } },
      onModelSelect: () => {},
      unconnectedProviders: [
        { name: "openai", label: "OpenAI", modelCount: 4, authKind: "key" },
      ],
      commands: [],
      onCommand: () => {},
      chrome: () => ({ goal: null, agents: [] }),
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    })
    try {
      expect(host.openSurface("models")).toBe(true)
      expect(host.shell.overlayItems).toContain("OpenAI — connect →")
      expect(host.shell.overlayItems.some((i) => i.includes("Go model on Zen path"))).toBe(
        false,
      )
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("refreshModels moves a selected pair into the Recent section", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4", "grok-3"] } },
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ goal: null, agents: [] }),
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    })
    try {
      host.refreshModels([{ provider: "xai", model: "grok-4" }], [])
      closeInsetOverlay(host.shell)
      expect(host.openSurface("models")).toBe(true)
      expect(host.shell.overlayItems[0]).toBe("xai / grok-4")
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("f toggles favorite on the focused row via onFavoriteToggle", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const toggled: string[] = []
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4"] } },
      onModelSelect: () => {},
      onFavoriteToggle: (id) => toggled.push(id),
      commands: [],
      onCommand: () => {},
      chrome: () => ({ goal: null, agents: [] }),
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    })
    try {
      expect(host.openSurface("models")).toBe(true)
      const fKey = { name: "f", ctrl: false, meta: false, option: true } as KeyEvent
      expect(runOverlayAction(host.shell, fKey)).toBe(true)
      expect(toggled).toEqual(["xai:grok-4"])
    } finally {
      host.dispose()
      harness.destroy()
    }
  })
})

describe("bottom border cost run", () => {
  test("omits the cost run when showPromptCost is unset (default off)", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ goal: null, agents: [] }),
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      readCostSummary: () => fakeCostSummary(),
    })
    try {
      const bottom = ruleOf(host.shell.promptBottomRule)
      expect(bottom).toContain("10%")
      expect(bottom).not.toContain("$0.42")
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("shows the cost run when showPromptCost reads true, and refreshCostContext repaints it live", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    let showCost = false
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ goal: null, agents: [] }),
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      readCostSummary: () => fakeCostSummary(),
      showPromptCost: () => showCost,
    })
    try {
      expect(ruleOf(host.shell.promptBottomRule)).not.toContain("$0.42")

      showCost = true
      host.refreshCostContext()
      expect(ruleOf(host.shell.promptBottomRule)).toContain("$0.42")
      expect(ruleOf(host.shell.promptBottomRule)).toContain("10%")
    } finally {
      host.dispose()
      harness.destroy()
    }
  })
})

/** Resolves true when the host exited, false when it is still alive. */
async function exited(host: { waitUntilExit: () => Promise<void> }): Promise<boolean> {
  return await Promise.race([
    host.waitUntilExit().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ])
}

describe("mountRunnerHost quit key", () => {
  const baseDeps = (harness: Awaited<ReturnType<typeof createHarness>>) => ({
    title: "test",
    eventEmitter: new EventEmitter(),
    send: () => {},
    interrupt: () => {},
    providers: {},
    onModelSelect: () => {},
    commands: [],
    onCommand: () => {},
    chrome: () => ({ goal: null, agents: [] }),
    subAgentSessions: () => [],
    createRenderer: async () => harness.renderer,
  })

  test("Ctrl+D mid-edit keeps the draft and the app alive", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const host = await mountRunnerHost(baseDeps(harness))
    try {
      for (const ch of "foo bar") harness.pressKey(ch)
      await harness.renderOnce()
      harness.pressKey("ARROW_LEFT")
      harness.pressKey("d", { ctrl: true })
      await harness.renderOnce()

      // Ctrl+D falls through to the textarea's delete-under-cursor.
      expect(host.shell.prompt.value).toBe("foo ba")
      expect(await exited(host)).toBe(false)
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  // Quitting is Ctrl+C twice. The host claims no key of its own, so an empty
  // prompt is not a special case: Ctrl+D stays the prompt's own binding.
  test("Ctrl+D at an empty prompt does not quit", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const host = await mountRunnerHost(baseDeps(harness))
    try {
      expect(host.shell.prompt.value).toBe("")
      harness.pressKey("d", { ctrl: true })
      await harness.renderOnce()

      expect(await exited(host)).toBe(false)
    } finally {
      host.dispose()
      harness.destroy()
    }
  })
})
