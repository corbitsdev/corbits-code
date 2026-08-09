import { describe, expect, test } from "bun:test"
import {
  annotateAgentTools,
  chromeFromSession,
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

  test("full state formats both zones", () => {
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
    expect(out.task).toEqual([
      { label: "chrome live helper", status: "doing" },
      { label: "wire chrome zone", status: "todo" },
      { label: "wire agents zone", status: "todo" },
    ])
    expect(out.agents).toEqual([
      {
        label: "explore: map setChromeZones callers",
        tail: " · 0:05 · grep",
        stalled: false,
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

  test("each row carries its own status", () => {
    expect(
      formatTasksPanel([
        { title: "first", status: "done" },
        { title: "second", status: "doing" },
        { title: "third", status: "todo" },
      ]),
    ).toEqual([
      { label: "first", status: "done" },
      { label: "second", status: "doing" },
      { label: "third", status: "todo" },
    ])
  })

  test("terminal (done/cancelled) rows still render — the panel is a live list, not just what remains", () => {
    expect(
      formatTasksPanel([
        { title: "a", status: "done" },
        { title: "b", status: "cancelled" },
      ]),
    ).toEqual([
      { label: "a", status: "done" },
      { label: "b", status: "cancelled" },
    ])
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

  test("one row per running agent, oldest-started first", () => {
    const rows = formatAgentsPanel(
      [
        { agentId: "a", description: "one", status: "running", currentToolStartedAt: null, startedAt: NOW - 1_000, lastActivityAt: NOW },
        { agentId: "b", description: "two", status: "running", currentToolStartedAt: null, startedAt: NOW - 2_000, lastActivityAt: NOW },
      ],
      undefined,
      NOW,
    )
    expect(rows).toEqual([
      { label: "2 agents", tail: "", stalled: false },
      { label: "b: two", tail: " · 0:02", stalled: false },
      { label: "a: one", tail: " · 0:01", stalled: false },
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

  test("stalled agent is visually distinct in its label", () => {
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
    expect(rows).toEqual([
      { label: "a: quiet worker", tail: " · 1:00 · quiet 0:40 · stalled", stalled: true },
    ])
  })

  test("bounds fan-out to maxVisible plus a +N more row", () => {
    const running = Array.from({ length: 8 }, (_, i) => ({
      agentId: `agent-${i}`,
      currentToolStartedAt: null,
      description: "working",
      status: "running" as const,
      startedAt: NOW,
      lastActivityAt: NOW,
    }))
    const rows = formatAgentsPanel(running, undefined, NOW, 5)
    // Fleet summary, five lanes, then the fold-away row.
    expect(rows?.[0]).toEqual({ label: "8 agents", tail: "", stalled: false })
    expect(rows).toHaveLength(7)
    expect(rows?.[6]).toEqual({ label: "+3 more", tail: "", stalled: false })
  })

  test("observe empty id+desc hides", () => {
    expect(
      formatAgentsPanel([], { agentId: "  ", description: "  " }, NOW),
    ).toBeNull()
  })

  test("row order is stable across an activity update between frames", () => {
    // Selection may key on staleness (lastActivityAt), but presentation must
    // not: lastActivityAt is the field a tool event updates most often, so
    // keying the visible row order on it would reshuffle the panel every
    // time any agent made progress — unreadable at a busy 200ms repaint.
    const frame1 = [
      { agentId: "b", description: "second", status: "running" as const, currentToolStartedAt: null, startedAt: NOW - 1_000, lastActivityAt: NOW - 1_000 },
      { agentId: "a", description: "first", status: "running" as const, currentToolStartedAt: null, startedAt: NOW - 2_000, lastActivityAt: NOW - 2_000 },
      { agentId: "c", description: "third", status: "running" as const, currentToolStartedAt: null, startedAt: NOW - 500, lastActivityAt: NOW - 500 },
    ]
    const rowsBefore = formatAgentsPanel(frame1, undefined, NOW)

    // Same agents, one tick later: "b" reported activity (its lastActivityAt
    // moved), the others did not. startedAt — what row order actually keys
    // on — is unchanged for all three.
    const frame2 = frame1.map((a) => (a.agentId === "b" ? { ...a, lastActivityAt: NOW + 200 } : a))
    const rowsAfter = formatAgentsPanel(frame2, undefined, NOW + 200)

    const lanes = (rows: readonly { label: string }[] | null) =>
      rows?.slice(1).map((r) => r.label.split(":")[0])
    expect(lanes(rowsBefore)).toEqual(lanes(rowsAfter))
    // Sanity: presentation order is oldest-started first (a, b, c), matching
    // the tiebreak-free startedAt sort.
    expect(lanes(rowsBefore)).toEqual(["a", "b", "c"])
  })

  test("a stalled agent stays visible over newer agents when the fan-out is truncated", () => {
    // The real feed (listForStrip) sorts running agents newest-first; the
    // panel must not blindly take that order, or the one worker most likely
    // to need attention is exactly the one that gets folded into "+N more".
    const newest = Array.from({ length: 5 }, (_, i) => ({
      agentId: `fresh-${i}`,
      currentToolStartedAt: null,
      description: "just started",
      status: "running" as const,
      startedAt: NOW,
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
    const rows = formatAgentsPanel([...newest, stalled], undefined, NOW, 5)
    expect(rows?.some((r) => r.label.includes("quiet"))).toBe(true)
    expect(rows?.some((r) => r.stalled)).toBe(true)
    expect(rows).toHaveLength(7)
    expect(rows?.[0]).toEqual({ label: "6 agents · 1 stalled", tail: "", stalled: true })
    expect(rows?.[6]).toEqual({ label: "+1 more", tail: "", stalled: false })
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
      },
    ])

    const zones = formatChromeZones(state, NOW)
    expect(zones.task).toEqual([
      { label: "wire catalogs", status: "doing" },
      { label: "export index", status: "todo" },
    ])
    expect(zones.agents).toEqual([
      { label: "explore: map callers", tail: " · grep", stalled: false },
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
    expect(rows?.[0]?.stalled).toBe(false)
    expect(rows?.[0]?.tail).toContain("run_shell 1:30")
    expect(rows?.[0]?.tail).not.toContain("stalled")

    expect(agentProgress(inTool, NOW)?.stat).toContain("run_shell 1:30")
  })

  test("a genuinely silent lane still reads stalled through the same hops", () => {
    const silent = { ...inTool, currentToolName: null, currentToolStartedAt: null }
    expect(laneState(silent, NOW)).toBe("stalled")

    const rows = formatAgentsPanel(
      chromeFromSession({ agents: [silent] }).agents,
      undefined,
      NOW,
    )
    expect(rows?.[0]?.stalled).toBe(true)
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
