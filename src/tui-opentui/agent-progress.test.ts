import { describe, expect, test } from "bun:test"
import { agentProgress, clockLabel } from "./agent-progress"

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
    expect(progress).toEqual({ stat: "0:42 · grep", working: true, stalled: false })
  })

  test("a running session with no current tool reports elapsed time alone", () => {
    const progress = agentProgress(
      { ...base, currentToolName: null, lastActivityAt: 42_000 },
      42_000,
    )
    expect(progress).toEqual({ stat: "0:42", working: true, stalled: false })
  })

  test("silence past the stall window flips working to stalled", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 0 }, 31_000, 30_000)
    expect(progress).toEqual({ stat: "0:31 · grep", working: false, stalled: true })
  })

  test("recent activity keeps a long-running session marked working", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 100_000 }, 100_500, 30_000)
    expect(progress?.working).toBe(true)
    expect(progress?.stalled).toBe(false)
  })
})
