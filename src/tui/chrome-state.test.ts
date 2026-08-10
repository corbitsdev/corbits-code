import { describe, expect, test } from "bun:test"
import {
  annotateAgentTools,
  chromeFromSession,
  clampBoardRows,
  formatAgentsPanel,
  formatChromeZones,
  formatTasksPanel,
  type ChromeLiveState,
} from "./chrome-state"
import { agentProgress, laneState } from "./agent-progress"

const NOW = 1_000_000

describe("formatChromeZones", () => {
  test("empty state hides all zones", () => {
    expect(formatChromeZones({})).toEqual({
      task: null,
      agents: null,
    })
    expect(
      formatChromeZones({
        task: null,
        agents: null,
        observe: null,
      }),
    ).toEqual({
      task: null,
      agents: null,
    })
  })

  test("partial: task rows only", () => {
    const out = formatChromeZones({
      task: [{ title: "cutover readiness", status: "doing" }],
    })
    expect(out.task).toEqual([{ label: "cutover readiness", status: "doing" }])
    expect(out.agents).toBeNull()
  })

  test("full state: fleet board wins — checklist suppressed while lanes run", () => {
    const state: ChromeLiveState = {
      task: [
        { title: "chrome live helper", status: "doing" },
        { title: "wire chrome zone", status: "todo" },
        { title: "wire agents zone", status: "todo" },
      ],
      agents: [
        {
          agentId: "explore",
          currentToolStartedAt: null,
          description: "map setChromeZones callers",
          status: "running",
          currentToolName: "grep",
          startedAt: NOW - 5_000,
          lastActivityAt: NOW,
        },
        {
          agentId: "general",
          currentToolStartedAt: null,
          description: "write tests",
          status: "done",
        },
      ],
    }
    const out = formatChromeZones(state, NOW)
    // One live surface (CL-5846): board owns the chrome while lanes run.
    expect(out.task).toBeNull()
    // Hybrid: board FLEET header + kind; tail is `state · agentProgress.stat`
    // (elapsed · tool), not the branch's tool-first wording.
    expect(out.agents).toEqual([
      { label: "FLEET  1 lane · 1 working", tail: "", stalled: false, kind: "header" },
      {
        label: "explore: map setChromeZones callers",
        tail: " · working · 0:05 · grep",
        stalled: false,
        kind: "lane",
      },
    ])
  })

  test("observe overrides the agents panel", () => {
    const out = formatChromeZones(
      {
        agents: [
          {
            agentId: "explore",
            currentToolStartedAt: null,
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
      {
        label: "observe: explore — map callers of openListOverlay",
        tail: "",
        stalled: false,
      },
    ])
  })
})

describe("formatTasksPanel", () => {
  test("null / undefined hide the zone", () => {
    expect(formatTasksPanel(null)).toBeNull()
    expect(formatTasksPanel(undefined)).toBeNull()
  })

  test("open work first; done rows trail while live work remains", () => {
    expect(
      formatTasksPanel([
        { title: "first", status: "done" },
        { title: "second", status: "doing" },
        { title: "third", status: "todo" },
      ]),
    ).toEqual([
      { label: "second", status: "doing" },
      { label: "third", status: "todo" },
      { label: "first", status: "done" },
    ])
  })

  test("terminal-only (all done/cancelled) collapses — no permanent [x] wall", () => {
    expect(
      formatTasksPanel([
        { title: "a", status: "done" },
        { title: "b", status: "cancelled" },
      ]),
    ).toBeNull()
  })

  test("empty array hides", () => {
    expect(formatTasksPanel([])).toBeNull()
  })

  test("bounds fan-out to maxVisible plus a +N more row", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      title: `task ${i}`,
      status: "todo" as const,
    }))
    const out = formatTasksPanel(rows, 5)
    expect(out).toHaveLength(6)
    expect(out?.[5]).toEqual({ label: "+3 more", status: null })
  })
})

describe("formatAgentsPanel", () => {
  test("empty hides", () => {
    expect(formatAgentsPanel(null, undefined, NOW)).toBeNull()
    expect(formatAgentsPanel([], undefined, NOW)).toBeNull()
  })

  test("a header row leads the board, then one row per running lane", () => {
    const rows = formatAgentsPanel(
      [
        { agentId: "a", description: "one", status: "running", currentToolStartedAt: null, startedAt: NOW - 1_000, lastActivityAt: NOW },
        { agentId: "b", description: "two", status: "running", currentToolStartedAt: null, startedAt: NOW - 2_000, lastActivityAt: NOW },
      ],
      undefined,
      NOW,
    )
    expect(rows).toEqual([
      { label: "FLEET  2 lanes · 2 working", tail: "", stalled: false, kind: "header" },
      { label: "b: two", tail: " · working · 0:02", stalled: false, kind: "lane" },
      { label: "a: one", tail: " · working · 0:01", stalled: false, kind: "lane" },
    ])
  })

  test("terminal-only list renders zero rows", () => {
    expect(
      formatAgentsPanel(
        [
          { agentId: "a", description: "x", status: "done", currentToolStartedAt: null },
          { agentId: "b", description: "y", status: "failed", currentToolStartedAt: null },
        ],
        undefined,
        NOW,
      ),
    ).toBeNull()
  })

  test("a stalled lane names its state and reports how long it has been silent", () => {
    const rows = formatAgentsPanel(
      [
        {
          agentId: "a",
          currentToolStartedAt: null,
          description: "quiet worker",
          status: "running",
          startedAt: NOW - 60_000,
          lastActivityAt: NOW - 40_000,
        },
      ],
      undefined,
      NOW,
    )
    // Hybrid uses main's agentProgress wording (`quiet`, with lifetime in the
    // stat) under the board's `stalled · …` prefix — not branch `silent`.
    expect(rows?.[1]).toEqual({
      label: "a: quiet worker",
      tail: " · stalled · 1:00 · quiet 0:40",
      stalled: true,
      kind: "lane",
    })
    expect(rows?.[0]?.label).toContain("1 stalled")
    expect(rows?.[0]?.kind).toBe("header")
  })

  test("trouble sorts above routine progress", () => {
    const rows = formatAgentsPanel(
      [
        { agentId: "fine", description: "busy", status: "running", currentToolStartedAt: null, startedAt: NOW - 1_000, lastActivityAt: NOW },
        { agentId: "quiet", description: "silent", status: "running", currentToolStartedAt: null, startedAt: NOW - 90_000, lastActivityAt: NOW - 60_000 },
      ],
      undefined,
      NOW,
    )
    expect(rows?.slice(1).map((r) => r.label.split(":")[0])).toEqual(["quiet", "fine"])
  })

  test("bounds fan-out and says how many lanes it is hiding", () => {
    const running = Array.from({ length: 8 }, (_, i) => ({
      agentId: `agent-${i}`,
      currentToolStartedAt: null,
      description: "working",
      status: "running" as const,
      startedAt: NOW + i,
      lastActivityAt: NOW,
    }))
    const rows = formatAgentsPanel(running, undefined, NOW, 6)
    expect(rows).toHaveLength(6)
    expect(rows?.[5]).toEqual({
      label: "+4 more lanes",
      tail: "",
      stalled: false,
      kind: "more",
    })
  })

  test("with too few rows for a disclosure line the header carries the count", () => {
    const running = Array.from({ length: 8 }, (_, i) => ({
      agentId: `agent-${i}`,
      currentToolStartedAt: null,
      description: "working",
      status: "running" as const,
      startedAt: NOW + i,
      lastActivityAt: NOW,
    }))
    // A whole row spent on "+N more" would cost more than the lane it displaces.
    const rows = formatAgentsPanel(running, undefined, NOW, 3)
    expect(rows).toHaveLength(3)
    expect(rows?.[0]?.tail).toBe(" · +6 hidden")
    expect(rows?.some((r) => r.kind === "more")).toBe(false)
  })

  test("observe empty id+desc hides", () => {
    expect(
      formatAgentsPanel([], { agentId: "  ", description: "  " }, NOW),
    ).toBeNull()
  })

  test("row order is stable across an activity update between frames", () => {
    // Neither sort key churns: a lane's state changes only when something real
    // happens to it, and startedAt never changes at all. Keying on
    // lastActivityAt would reshuffle the board on every tool event.
    const frame1 = [
      { agentId: "b", description: "second", status: "running" as const, currentToolStartedAt: null, startedAt: NOW - 1_000, lastActivityAt: NOW - 1_000 },
      { agentId: "a", description: "first", status: "running" as const, currentToolStartedAt: null, startedAt: NOW - 2_000, lastActivityAt: NOW - 2_000 },
      { agentId: "c", description: "third", status: "running" as const, currentToolStartedAt: null, startedAt: NOW - 500, lastActivityAt: NOW - 500 },
    ]
    const rowsBefore = formatAgentsPanel(frame1, undefined, NOW)

    const frame2 = frame1.map((a) => (a.agentId === "b" ? { ...a, lastActivityAt: NOW + 200 } : a))
    const rowsAfter = formatAgentsPanel(frame2, undefined, NOW + 200)

    expect(rowsBefore?.map((r) => r.label.split(":")[0])).toEqual(
      rowsAfter?.map((r) => r.label.split(":")[0]),
    )
    expect(rowsBefore?.slice(1).map((r) => r.label.split(":")[0])).toEqual(["a", "b", "c"])
  })

  test("a stalled lane survives a truncated fan-out", () => {
    // The real feed sorts newest-first; the board must not take that order, or
    // the one lane most likely to need attention is exactly the one hidden.
    const newest = Array.from({ length: 5 }, (_, i) => ({
      agentId: `fresh-${i}`,
      currentToolStartedAt: null,
      description: "just started",
      status: "running" as const,
      startedAt: NOW + i,
      lastActivityAt: NOW,
    }))
    const stalled = {
      agentId: "quiet",
      currentToolStartedAt: null,
      description: "gone silent",
      status: "running" as const,
      startedAt: NOW - 300_000,
      lastActivityAt: NOW - 250_000,
    }
    const rows = formatAgentsPanel([...newest, stalled], undefined, NOW, 4)
    expect(rows?.some((r) => r.label.includes("quiet"))).toBe(true)
    expect(rows?.some((r) => r.stalled)).toBe(true)
    // And the ones it could not show are still accounted for.
    expect(rows?.[0]?.label).toContain("6 lanes")
    expect(rows?.[0]?.label).toContain("1 stalled")
  })
})

describe("chromeFromSession", () => {
  test("maps tasks / agents loosely", () => {
    const state = chromeFromSession({
      tasks: [
        { title: "wire catalogs", status: "doing" },
        { title: "export index", status: "todo" },
      ],
      agents: [
        {
          agentId: "explore",
          currentToolStartedAt: null,
          description: "map callers",
          status: "running",
          currentToolName: "grep",
          // Clocks so fleetProgress can count the lane (without them the hybrid
          // header would report 0 lanes while the board still paints the row).
          startedAt: NOW - 5_000,
          lastActivityAt: NOW,
        },
      ],
    })

    expect(state.task).toEqual([
      { title: "wire catalogs", status: "doing" },
      { title: "export index", status: "todo" },
    ])
    expect(state.agents).toEqual([
      {
        agentId: "explore",
        currentToolStartedAt: null,
        description: "map callers",
        status: "running",
        currentToolName: "grep",
        startedAt: NOW - 5_000,
        lastActivityAt: NOW,
      },
    ])

    const zones = formatChromeZones(state, NOW)
    // Fleet board owns chrome while lanes run; checklist is suppressed (CL-5846).
    expect(zones.task).toBeNull()
    expect(zones.agents).toEqual([
      { label: "FLEET  1 lane · 1 working", tail: "", stalled: false, kind: "header" },
      { label: "explore: map callers", tail: " · working · 0:05 · grep", stalled: false, kind: "lane" },
    ])
  })

  test("falls back agent id; empty bags hide", () => {
    const state = chromeFromSession({
      tasks: [],
      agents: [
        {
          id: "sess-1",
          description: "write tests",
          status: "done",
          currentToolStartedAt: null,
        },
      ],
    })
    expect(state.task).toBeNull()
    expect(state.agents?.[0]?.agentId).toBe("sess-1")
  })

  test("observe passes through", () => {
    const state = chromeFromSession({
      observe: { agentId: "explore", description: "watch" },
    })
    expect(state.observe).toEqual({
      agentId: "explore",
      description: "watch",
    })
    expect(formatChromeZones(state, NOW).agents).toEqual([
      { label: "observe: explore — watch", tail: "", stalled: false },
    ])
  })
})


describe("annotateAgentTools", () => {
  const state: ChromeLiveState = {
    agents: [
      { agentId: "explore", description: "map callers", status: "running", currentToolStartedAt: null },
      { agentId: "review", description: "map callers", status: "done", currentToolStartedAt: null },
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


describe("lane state survives the mapping hops", () => {
  // The panel and the transcript trailer reach laneState by different routes.
  // A hop that drops currentToolStartedAt silently reclassifies a busy lane as
  // stalled — which is exactly how this shipped broken once, caught only by
  // running it. The types make the drop a compile error; this proves the two
  // routes still agree on a live example.
  const inTool = {
    id: "sess-1",
    agentId: "worker",
    description: "sleep 150",
    status: "running" as const,
    currentToolName: "run_shell",
    currentToolPreview: null as string | null,
    currentToolStartedAt: NOW - 90_000,
    startedAt: NOW - 100_000,
    lastActivityAt: NOW - 90_000,
  }

  test("the panel and the transcript row agree that the lane is in a tool", () => {
    expect(laneState(inTool, NOW)).toBe("in_tool")

    const rows = formatAgentsPanel(
      chromeFromSession({ agents: [inTool] }).agents,
      undefined,
      NOW,
    )
    // Board: header first, then the lane. Operator copy uses "in tool", not
    // the machine LaneState token.
    expect(rows?.[0]?.kind).toBe("header")
    expect(rows?.[0]?.label).toContain("in tool")
    expect(rows?.[1]?.kind).toBe("lane")
    expect(rows?.[1]?.stalled).toBe(false)
    expect(rows?.[1]?.tail).toContain("in tool")
    expect(rows?.[1]?.tail).not.toContain("in_tool")
    expect(rows?.[1]?.tail).toContain("run_shell 1:30")
    expect(rows?.[1]?.tail).not.toContain("stalled")

    expect(agentProgress(inTool, NOW)?.stat).toContain("run_shell 1:30")
  })

  test("a shell preview replaces the tool name on both panel and trailer (CL-5765)", () => {
    const withPreview = {
      ...inTool,
      currentToolPreview: "bun test ./src",
    }
    const rows = formatAgentsPanel(
      chromeFromSession({ agents: [withPreview] }).agents,
      undefined,
      NOW,
    )
    expect(rows?.[1]?.tail).toContain("bun test ./src")
    expect(rows?.[1]?.tail).not.toContain("run_shell")
    expect(agentProgress(withPreview, NOW)?.stat).toContain("bun test ./src")
    expect(agentProgress(withPreview, NOW)?.stat).not.toContain("run_shell")
  })

  test("a genuinely silent lane still reads stalled through the same hops", () => {
    const silent = { ...inTool, currentToolName: null, currentToolStartedAt: null }
    expect(laneState(silent, NOW)).toBe("stalled")

    const rows = formatAgentsPanel(
      chromeFromSession({ agents: [silent] }).agents,
      undefined,
      NOW,
    )
    expect(rows?.[0]?.kind).toBe("header")
    expect(rows?.[0]?.label).toContain("1 stalled")
    expect(rows?.[1]?.stalled).toBe(true)
    expect(rows?.[1]?.kind).toBe("lane")
  })

  // A progress ping renames the tool but carries no clock of its own, so it
  // must not override a call the store is already timing.
  test("the tool annotation never repaints a live call with another name", () => {
    const annotated = annotateAgentTools(
      { agents: [inTool] },
      new Map([["sleep 150", "grep"]]),
    )
    expect(annotated.agents?.[0]?.currentToolName).toBe("run_shell")
    expect(annotated.agents?.[0]?.currentToolStartedAt).toBe(NOW - 90_000)
  })

  test("the tool annotation still fills a gap when no call is outstanding", () => {
    const idle = { ...inTool, currentToolName: null, currentToolStartedAt: null }
    const annotated = annotateAgentTools(
      { agents: [idle] },
      new Map([["sleep 150", "grep"]]),
    )
    expect(annotated.agents?.[0]?.currentToolName).toBe("grep")
    expect(annotated.agents?.[0]?.currentToolStartedAt).toBeNull()
  })
})

describe("clampBoardRows", () => {
  test("carries a prior more-row count into a tighter re-clamp", () => {
    // Formatter already hid 4 of 8; collapse then grants only 4 rows total.
    // Honest disclosure is 4 prior + 2 newly dropped = 6, not 2.
    const formatted = [
      { label: "FLEET  8 lanes · 8 working", tail: "", stalled: false, kind: "header" as const },
      { label: "a: one", tail: " · working · 0:01", stalled: false, kind: "lane" as const },
      { label: "b: two", tail: " · working · 0:01", stalled: false, kind: "lane" as const },
      { label: "c: three", tail: " · working · 0:01", stalled: false, kind: "lane" as const },
      { label: "d: four", tail: " · working · 0:01", stalled: false, kind: "lane" as const },
      { label: "+4 more lanes", tail: "", stalled: false, kind: "more" as const },
    ]
    const clamped = clampBoardRows(formatted, 4)
    expect(clamped).toHaveLength(4)
    expect(clamped[0]?.kind).toBe("header")
    expect(clamped[0]?.tail).toBe("")
    expect(clamped[3]).toEqual({
      label: "+6 more lanes",
      tail: "",
      stalled: false,
      kind: "more",
    })
  })

  test("under a tight height the header carries the total hidden count", () => {
    const formatted = [
      { label: "FLEET  8 lanes · 8 working", tail: " · +4 hidden", stalled: false, kind: "header" as const },
      { label: "a: one", tail: " · working · 0:01", stalled: false, kind: "lane" as const },
      { label: "b: two", tail: " · working · 0:01", stalled: false, kind: "lane" as const },
    ]
    const clamped = clampBoardRows(formatted, 2)
    expect(clamped).toHaveLength(2)
    // 4 prior + 1 newly dropped lane = 5.
    expect(clamped[0]?.tail).toBe(" · +5 hidden")
    expect(clamped.some((r) => r.kind === "more")).toBe(false)
  })
})

