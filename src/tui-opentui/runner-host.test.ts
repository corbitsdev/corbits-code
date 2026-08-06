import { describe, expect, test } from "bun:test"

import type { SubAgentSession } from "../subagent/session-store.js"
import {
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
    ).toEqual({ role: "tool", text: "boom", meta: "grep!" })
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
