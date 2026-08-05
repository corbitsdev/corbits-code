import { describe, expect, test } from "bun:test"
import {
  formatAgentsLine,
  formatChromeZones,
  formatGoalLine,
  formatTaskLine,
  type ChromeLiveState,
} from "./chrome-state"

describe("formatChromeZones", () => {
  test("empty state hides all zones", () => {
    expect(formatChromeZones({})).toEqual({
      goal: null,
      task: null,
      agents: null,
    })
    expect(
      formatChromeZones({
        goal: null,
        task: null,
        agents: null,
        observe: null,
      }),
    ).toEqual({
      goal: null,
      task: null,
      agents: null,
    })
  })

  test("partial: goal only", () => {
    const out = formatChromeZones({
      goal: {
        title: "Wave 7 residual surfaces",
        phase: "implementing",
        status: "active",
        progress: { done: 1, total: 3 },
      },
    })
    expect(out.goal).toBe("goal: impl · 1/3 · Wave 7 residual surfaces")
    expect(out.task).toBeNull()
    expect(out.agents).toBeNull()
  })

  test("partial: task string only", () => {
    const out = formatChromeZones({ task: "cutover readiness" })
    expect(out.goal).toBeNull()
    expect(out.task).toBe("task: cutover readiness")
    expect(out.agents).toBeNull()
  })

  test("full state formats all three zones", () => {
    const state: ChromeLiveState = {
      goal: {
        title: "1:1 OpenTUI cutover",
        phase: "reviewing",
        status: "active",
        progress: { done: 2, total: 4 },
      },
      task: {
        title: "chrome live helper",
        status: "doing",
        remaining: 2,
      },
      agents: [
        {
          agentId: "explore",
          description: "map setChromeZones callers",
          status: "running",
          currentToolName: "grep",
        },
        {
          agentId: "general",
          description: "write tests",
          status: "done",
        },
      ],
    }
    const out = formatChromeZones(state)
    expect(out.goal).toBe("goal: review · 2/4 · 1:1 OpenTUI cutover")
    expect(out.task).toBe("task: chrome live helper (+2)")
    expect(out.agents).toContain("1 live")
    expect(out.agents).toContain("explore:")
    expect(out.agents).toContain("grep")
    expect(out.agents).toContain("1 done")
  })

  test("observe overrides agents line", () => {
    const out = formatChromeZones({
      agents: [
        {
          agentId: "explore",
          description: "map callers",
          status: "running",
        },
      ],
      observe: {
        agentId: "explore",
        description: "map callers of openListOverlay",
      },
    })
    expect(out.agents).toBe(
      "observe: explore — map callers of openListOverlay",
    )
  })
})

describe("formatGoalLine", () => {
  test("null / empty / inactive hide", () => {
    expect(formatGoalLine(null)).toBeNull()
    expect(formatGoalLine(undefined)).toBeNull()
    expect(formatGoalLine({ title: "   " })).toBeNull()
    expect(
      formatGoalLine({ title: "x", status: "inactive" }),
    ).toBeNull()
    expect(formatGoalLine({ title: "x", status: "cleared" })).toBeNull()
  })

  test("achieved freezes completed label", () => {
    expect(
      formatGoalLine({
        title: "ship cutover",
        status: "achieved",
        phase: "completed",
      }),
    ).toBe("goal: completed · ship cutover")
  })

  test("paused surfaces status", () => {
    expect(
      formatGoalLine({
        title: "ship cutover",
        phase: "implementing",
        status: "paused",
      }),
    ).toBe("goal: impl · paused · ship cutover")
  })

  test("title only", () => {
    expect(formatGoalLine({ title: "solo brief" })).toBe(
      "goal: solo brief",
    )
  })
})

describe("formatTaskLine", () => {
  test("string / empty", () => {
    expect(formatTaskLine(null)).toBeNull()
    expect(formatTaskLine("")).toBeNull()
    expect(formatTaskLine("  ")).toBeNull()
    expect(formatTaskLine("wire host")).toBe("task: wire host")
  })

  test("structured with remaining", () => {
    expect(
      formatTaskLine({
        title: "format chrome",
        status: "doing",
        remaining: 1,
      }),
    ).toBe("task: format chrome (+1)")
  })

  test("terminal structured hides", () => {
    expect(
      formatTaskLine({ title: "done item", status: "done" }),
    ).toBeNull()
  })

  test("rows pick doing and remaining", () => {
    expect(
      formatTaskLine([
        { title: "first", status: "done" },
        { title: "second", status: "doing" },
        { title: "third", status: "todo" },
      ]),
    ).toBe("task: second (+1)")
  })

  test("rows all terminal hide", () => {
    expect(
      formatTaskLine([
        { title: "a", status: "done" },
        { title: "b", status: "cancelled" },
      ]),
    ).toBeNull()
  })

  test("does not double-prefix", () => {
    expect(formatTaskLine("task: already prefixed")).toBe(
      "task: already prefixed",
    )
  })
})

describe("formatAgentsLine", () => {
  test("empty hides", () => {
    expect(formatAgentsLine(null)).toBeNull()
    expect(formatAgentsLine([])).toBeNull()
  })

  test("multi live summary without single-agent detail", () => {
    expect(
      formatAgentsLine([
        {
          agentId: "a",
          description: "one",
          status: "running",
        },
        {
          agentId: "b",
          description: "two",
          status: "running",
        },
      ]),
    ).toBe("agents: 2 live")
  })

  test("terminal-only list still counts", () => {
    expect(
      formatAgentsLine([
        { agentId: "a", description: "x", status: "done" },
        { agentId: "b", description: "y", status: "failed" },
      ]),
    ).toBe("agents: 1 done · 1 failed")
  })

  test("observe empty id+desc hides", () => {
    expect(
      formatAgentsLine([], { agentId: "  ", description: "  " }),
    ).toBeNull()
  })
})
