import { describe, expect, test } from "bun:test"
import {
  annotateAgentTools,
  chromeFromSession,
  formatAgentsPanel,
  formatChromeZones,
  formatGoalLine,
  formatTaskLine,
  type ChromeLiveState,
} from "./chrome-state"

const NOW = 1_000_000

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
          startedAt: NOW - 5_000,
          lastActivityAt: NOW,
        },
        {
          agentId: "general",
          description: "write tests",
          status: "done",
        },
      ],
    }
    const out = formatChromeZones(state, NOW)
    expect(out.goal).toBe("goal: review · 2/4 · 1:1 OpenTUI cutover")
    expect(out.task).toBe("task: chrome live helper (+2)")
    expect(out.agents).toEqual(["explore: map setChromeZones callers · 0:05 · grep"])
  })

  test("observe overrides the agents panel", () => {
    const out = formatChromeZones(
      {
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
      },
      NOW,
    )
    expect(out.agents).toEqual([
      "observe: explore — map callers of openListOverlay",
    ])
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

describe("formatAgentsPanel", () => {
  test("empty hides", () => {
    expect(formatAgentsPanel(null, undefined, NOW)).toBeNull()
    expect(formatAgentsPanel([], undefined, NOW)).toBeNull()
  })

  test("one row per running agent", () => {
    expect(
      formatAgentsPanel(
        [
          { agentId: "a", description: "one", status: "running", startedAt: NOW - 1_000, lastActivityAt: NOW },
          { agentId: "b", description: "two", status: "running", startedAt: NOW - 2_000, lastActivityAt: NOW },
        ],
        undefined,
        NOW,
      ),
    ).toEqual(["a: one · 0:01", "b: two · 0:02"])
  })

  test("terminal-only list renders zero rows", () => {
    expect(
      formatAgentsPanel(
        [
          { agentId: "a", description: "x", status: "done" },
          { agentId: "b", description: "y", status: "failed" },
        ],
        undefined,
        NOW,
      ),
    ).toBeNull()
  })

  test("stalled agent is visually distinct in its label", () => {
    const rows = formatAgentsPanel(
      [
        {
          agentId: "a",
          description: "quiet worker",
          status: "running",
          startedAt: NOW - 60_000,
          lastActivityAt: NOW - 40_000,
        },
      ],
      undefined,
      NOW,
    )
    expect(rows).toEqual(["a: quiet worker · 1:00 · stalled"])
  })

  test("bounds fan-out to maxVisible plus a +N more row", () => {
    const running = Array.from({ length: 8 }, (_, i) => ({
      agentId: `agent-${i}`,
      description: "working",
      status: "running" as const,
      startedAt: NOW,
      lastActivityAt: NOW,
    }))
    const rows = formatAgentsPanel(running, undefined, NOW, 5)
    expect(rows).toHaveLength(6)
    expect(rows?.[5]).toBe("+3 more")
  })

  test("observe empty id+desc hides", () => {
    expect(
      formatAgentsPanel([], { agentId: "  ", description: "  " }, NOW),
    ).toBeNull()
  })
})

describe("chromeFromSession", () => {
  test("maps goal governor / tasks / agents loosely", () => {
    const state = chromeFromSession({
      goal: {
        brief: "ship cutover",
        status: "active",
        phase: "implementing",
        criteria: [
          { status: "done" },
          { status: "todo" },
          { status: "cancelled" },
        ],
      },
      tasks: [
        { title: "wire catalogs", status: "doing" },
        { title: "export index", status: "todo" },
      ],
      agents: [
        {
          agentId: "explore",
          description: "map callers",
          status: "running",
          currentToolName: "grep",
        },
      ],
    })

    expect(state.goal).toEqual({
      title: "ship cutover",
      status: "active",
      phase: "implementing",
      progress: { done: 1, total: 2 },
    })
    expect(state.task).toEqual([
      { title: "wire catalogs", status: "doing" },
      { title: "export index", status: "todo" },
    ])
    expect(state.agents).toEqual([
      {
        agentId: "explore",
        description: "map callers",
        status: "running",
        currentToolName: "grep",
      },
    ])

    const zones = formatChromeZones(state, NOW)
    expect(zones.goal).toBe("goal: impl · 1/2 · ship cutover")
    expect(zones.task).toBe("task: wire catalogs (+1)")
    expect(zones.agents).toEqual(["explore: map callers · grep"])
  })

  test("falls back agent id and goal condition; empty bags hide", () => {
    const state = chromeFromSession({
      goal: { condition: "all tests green", status: "active" },
      tasks: [],
      agents: [
        {
          id: "sess-1",
          description: "write tests",
          status: "done",
        },
      ],
    })
    expect(state.goal?.title).toBe("all tests green")
    expect(state.task).toBeNull()
    expect(state.agents?.[0]?.agentId).toBe("sess-1")
  })

  test("null goal clears; observe passes through", () => {
    const state = chromeFromSession({
      goal: null,
      observe: { agentId: "explore", description: "watch" },
    })
    expect(state.goal).toBeNull()
    expect(state.observe).toEqual({
      agentId: "explore",
      description: "watch",
    })
    expect(formatChromeZones(state, NOW).agents).toEqual([
      "observe: explore — watch",
    ])
  })
})


describe("annotateAgentTools", () => {
  const state: ChromeLiveState = {
    agents: [
      { agentId: "explore", description: "map callers", status: "running" },
      { agentId: "review", description: "map callers", status: "done" },
    ],
  }

  test("running agents pick up the live tool name", () => {
    const tools = new Map([["map callers", "grep"]])
    const next = annotateAgentTools(state, tools)
    expect(next.agents?.[0]?.currentToolName).toBe("grep")
    expect(next.agents?.[1]?.currentToolName).toBeUndefined()
  })

  test("unknown descriptions and empty maps leave the state alone", () => {
    expect(annotateAgentTools(state, new Map())).toBe(state)
    const next = annotateAgentTools(state, new Map([["other work", "grep"]]))
    expect(next.agents?.[0]?.currentToolName).toBeUndefined()
  })
})
