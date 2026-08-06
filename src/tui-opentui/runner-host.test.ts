import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"

import type { KeyEvent } from "@opentui/core"

import type { SubAgentSession } from "../subagent/session-store.js"
import { createHarness } from "./harness.js"
import { closeInsetOverlay, runOverlayAction } from "./shell.js"
import {
  mountRunnerHost,
  observeSessionFromSubAgents,
  rowFromTranscriptEntry,
} from "./runner-host.js"

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
    ).toEqual({ role: "tool", text: "{}", meta: "grep" })
    expect(
      rowFromTranscriptEntry({
        kind: "tool_result",
        callId: "c",
        name: "grep",
        content: "boom",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "boom", meta: "grep", result: true, failed: true })
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
          }),
          setCompactionMode: () => {},
          setSessionMode: () => {},
          setMaxConcurrentSubAgents: () => {},
          setWaitForApproval: () => {},
          setTelemetryEnabled: () => {},
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
      const fKey = { name: "f", ctrl: false, meta: false, option: false } as KeyEvent
      expect(runOverlayAction(host.shell, fKey)).toBe(true)
      expect(toggled).toEqual(["xai:grok-4"])
    } finally {
      host.dispose()
      harness.destroy()
    }
  })
})
