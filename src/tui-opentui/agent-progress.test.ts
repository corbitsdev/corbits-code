import { describe, expect, test } from "bun:test"
import {
  agentProgress,
  clockLabel,
  fleetLabel,
  fleetProgress,
  laneState,
} from "./agent-progress"

describe("clockLabel", () => {
  test("formats sub-minute and multi-minute elapsed as m:ss", () => {
    expect(clockLabel(0)).toBe("0:00")
    expect(clockLabel(42_000)).toBe("0:42")
    expect(clockLabel(90_000)).toBe("1:30")
  })
})

describe("agentProgress", () => {
  const base = {
    status: "running" as const,
    currentToolName: "grep",
    currentToolStartedAt: null,
    startedAt: 0,
    lastActivityAt: 0,
  }

  test("terminal sessions have no pending-row progress", () => {
    expect(agentProgress({ ...base, status: "done" }, 1000)).toBeNull()
    expect(agentProgress({ ...base, status: "failed" }, 1000)).toBeNull()
    expect(agentProgress({ ...base, status: "cancelled" }, 1000)).toBeNull()
  })

  test("a running session reports elapsed time and its current tool", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 42_000 }, 42_000)
    expect(progress).toEqual({
      stat: "0:42 · grep",
      state: "working",
      working: true,
      stalled: false,
    })
  })

  test("a running session with no current tool reports elapsed time alone", () => {
    const progress = agentProgress(
      { ...base, currentToolName: null, lastActivityAt: 42_000 },
      42_000,
    )
    expect(progress).toEqual({
      stat: "0:42",
      state: "working",
      working: true,
      stalled: false,
    })
  })

  test("silence with no tool outstanding is a stall, and the clock shown is the silence", () => {
    const progress = agentProgress(
      { ...base, currentToolName: null, lastActivityAt: 0 },
      31_000,
      30_000,
    )
    expect(progress).toEqual({
      stat: "0:31 · quiet 0:31",
      state: "stalled",
      working: false,
      stalled: true,
    })
  })

  // The defect the whole surface turned on: a worker inside one long tool call
  // emits nothing for the entire execution, so every lane of a fleet running
  // e.g. a test suite flipped to "stalled" simultaneously while working fine.
  test("silence inside an outstanding tool call is not a stall", () => {
    const progress = agentProgress(
      {
        ...base,
        currentToolName: "run_shell",
        currentToolStartedAt: 1_000,
        lastActivityAt: 1_000,
      },
      91_000,
      30_000,
    )
    expect(progress?.state).toBe("in_tool")
    expect(progress?.stalled).toBe(false)
    expect(progress?.stat).toBe("1:31 · run_shell 1:30")
  })

  test("recent activity keeps a long-running session marked working", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 100_000 }, 100_500, 30_000)
    expect(progress?.working).toBe(true)
    expect(progress?.stalled).toBe(false)
  })
})

describe("laneState", () => {
  const running = {
    status: "running" as const,
    currentToolName: null,
    currentToolStartedAt: null,
    startedAt: 0,
    lastActivityAt: 0,
  }

  test("names the three lanes a running worker can be in", () => {
    expect(laneState({ ...running, lastActivityAt: 1_000 }, 2_000, 30_000)).toBe("working")
    expect(laneState(running, 60_000, 30_000)).toBe("stalled")
    expect(
      laneState(
        { ...running, currentToolName: "run_shell", currentToolStartedAt: 0 },
        60_000,
        30_000,
      ),
    ).toBe("in_tool")
  })
})

describe("fleetProgress", () => {
  const lane = (over: Partial<Parameters<typeof laneState>[0]>) => ({
    status: "running" as const,
    currentToolName: null,
    currentToolStartedAt: null,
    startedAt: 0,
    lastActivityAt: 0,
    ...over,
  })

  test("counts only running lanes, bucketed by their single lane state", () => {
    const fleet = fleetProgress(
      [
        lane({ lastActivityAt: 59_000 }),
        lane({ currentToolName: "run_shell", currentToolStartedAt: 0 }),
        lane({}),
        lane({ status: "done" }),
      ],
      60_000,
      30_000,
    )
    expect(fleet).toEqual({ running: 3, working: 1, inTool: 1, stalled: 1 })
  })

  test("no sub-agents leaves the fleet empty", () => {
    expect(fleetProgress([], 1_000)).toEqual({
      running: 0,
      working: 0,
      inTool: 0,
      stalled: 0,
    })
  })
})

describe("fleetLabel", () => {
  test("is null with nothing running so the single-agent case is untouched", () => {
    expect(fleetLabel({ running: 0, working: 0, inTool: 0, stalled: 0 })).toBeNull()
  })

  test("names the stalled count when any lane is stuck", () => {
    expect(fleetLabel({ running: 6, working: 4, inTool: 0, stalled: 2 })).toBe(
      "6 agents · 2 stalled",
    )
  })

  test("says when the whole fleet is inside tool calls", () => {
    expect(fleetLabel({ running: 3, working: 0, inTool: 3, stalled: 0 })).toBe(
      "3 agents · in tools",
    )
  })
})
