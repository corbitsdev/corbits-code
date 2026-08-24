import { describe, expect, test } from "bun:test";
import {
  AGENTS_PANEL_LINGER_MS,
  agentIsLingering,
  agentsChromeNeedsSticky,
  annotateAgentTools,
  chromeFromSession,
  clampBoardRows,
  formatAgentsPanel,
  formatChromeZones,
  formatTasksPanel,
  type ChromeLiveState,
} from "./chrome-state";
import { agentProgress, laneState } from "./agent-progress";

const NOW = 1_000_000;

describe("formatChromeZones", () => {
  test("empty state hides all zones", () => {
    expect(formatChromeZones({})).toEqual({
      task: null,
      agents: null,
    });
    expect(
      formatChromeZones({
        task: null,
        agents: null,
        observe: null,
      }),
    ).toEqual({
      task: null,
      agents: null,
    });
  });

  test("partial: task rows stay parked; agents absent stays null", () => {
    const out = formatChromeZones({
      task: [{ title: "cutover readiness", status: "doing" }],
    });
    expect(out.task).toBeNull();
    expect(out.agents).toBeNull();
  });

  test("running agents paint the agents strip; task stays null", () => {
    const state: ChromeLiveState = {
      task: [
        { title: "chrome live helper", status: "doing" },
        { title: "wire chrome zone", status: "todo" },
        { title: "wire agents zone", status: "todo" },
      ],
      agents: [
        {
          agentId: "explorer",
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
    };
    const out = formatChromeZones(state, NOW);
    expect(out.task).toBeNull();
    expect(out.agents).not.toBeNull();
    expect(out.agents?.[0]?.label).toContain("explorer");
    expect(out.agents?.[0]?.kind).toBe("lane");
    expect(out.agents?.some((r) => r.kind === "header")).toBe(false);
  });

  test("idle terminal agents without linger hide; open checklist still parked", () => {
    const out = formatChromeZones(
      {
        task: [
          { title: "chrome live helper", status: "doing" },
          { title: "wire chrome zone", status: "todo" },
        ],
        agents: [
          {
            agentId: "general",
            currentToolStartedAt: null,
            description: "write tests",
            status: "done",
          },
        ],
      },
      NOW,
    );
    expect(out.agents).toBeNull();
    expect(out.task).toBeNull();
  });

  test("observe replaces the agents strip via formatChromeZones", () => {
    const out = formatChromeZones(
      {
        agents: [
          {
            agentId: "explorer",
            currentToolStartedAt: null,
            description: "map callers",
            status: "running",
          },
        ],
        observe: {
          agentId: "explorer",
          description: "map callers of openListOverlay",
        },
      },
      NOW,
    );
    expect(out.task).toBeNull();
    expect(out.agents).toEqual([
      {
        label: "observe: explorer — map callers of openListOverlay",
        tail: "",
        stalled: false,
        kind: "lane",
        status: "running",
      },
    ]);
  });
});

describe("agentsChromeNeedsSticky / linger", () => {
  test("running agents need sticky", () => {
    expect(
      agentsChromeNeedsSticky(
        [
          {
            agentId: "a",
            description: "x",
            status: "running",
            currentToolStartedAt: null,
          },
        ],
        NOW,
      ),
    ).toBe(true);
  });

  test("terminal inside linger window needs sticky", () => {
    const session = {
      agentId: "a",
      description: "x",
      status: "done" as const,
      currentToolStartedAt: null,
      finishedAt: NOW - 1_000,
    };
    expect(agentIsLingering(session, NOW)).toBe(true);
    expect(agentsChromeNeedsSticky([session], NOW)).toBe(true);
  });

  test("terminal past linger does not need sticky", () => {
    const session = {
      agentId: "a",
      description: "x",
      status: "failed" as const,
      currentToolStartedAt: null,
      finishedAt: NOW - AGENTS_PANEL_LINGER_MS,
    };
    expect(agentIsLingering(session, NOW)).toBe(false);
    expect(agentsChromeNeedsSticky([session], NOW)).toBe(false);
  });

  test("empty / undefined agents do not need sticky", () => {
    expect(agentsChromeNeedsSticky(null, NOW)).toBe(false);
    expect(agentsChromeNeedsSticky(undefined, NOW)).toBe(false);
    expect(agentsChromeNeedsSticky([], NOW)).toBe(false);
  });
});

describe("formatTasksPanel", () => {
  test("null / undefined hide the zone", () => {
    expect(formatTasksPanel(null)).toBeNull();
    expect(formatTasksPanel(undefined)).toBeNull();
  });

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
    ]);
  });

  test("terminal-only (all done/cancelled) collapses — no permanent [x] wall", () => {
    expect(
      formatTasksPanel([
        { title: "a", status: "done" },
        { title: "b", status: "cancelled" },
      ]),
    ).toBeNull();
  });

  test("empty array hides", () => {
    expect(formatTasksPanel([])).toBeNull();
  });

  test("bounds fan-out to maxVisible plus a +N more row", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      title: `task ${i}`,
      status: "todo" as const,
    }));
    const out = formatTasksPanel(rows, 5);
    expect(out).toHaveLength(6);
    expect(out?.[5]).toEqual({ label: "+3 more", status: null });
  });
});

describe("formatAgentsPanel", () => {
  test("empty hides", () => {
    expect(formatAgentsPanel(null, undefined, NOW)).toBeNull();
    expect(formatAgentsPanel([], undefined, NOW)).toBeNull();
  });

  test("flat list: one row per running lane, no FLEET header", () => {
    const rows = formatAgentsPanel(
      [
        {
          agentId: "a",
          description: "one",
          status: "running",
          currentToolStartedAt: null,
          startedAt: NOW - 1_000,
          lastActivityAt: NOW,
        },
        {
          agentId: "b",
          description: "two",
          status: "running",
          currentToolStartedAt: null,
          startedAt: NOW - 2_000,
          lastActivityAt: NOW,
        },
      ],
      undefined,
      NOW,
    );
    expect(rows).toEqual([
      { label: "● b  two", tail: " · 0:02", stalled: false, kind: "lane", status: "running" },
      { label: "● a  one", tail: " · 0:01", stalled: false, kind: "lane", status: "running" },
    ]);
    expect(rows?.some((r) => r.kind === "header")).toBe(false);
  });

  test("terminal-only list without finishedAt renders zero rows", () => {
    expect(
      formatAgentsPanel(
        [
          { agentId: "a", description: "x", status: "done", currentToolStartedAt: null },
          { agentId: "b", description: "y", status: "failed", currentToolStartedAt: null },
        ],
        undefined,
        NOW,
      ),
    ).toBeNull();
  });

  test("terminal rows linger for AGENTS_PANEL_LINGER_MS after finishedAt", () => {
    const rows = formatAgentsPanel(
      [
        {
          agentId: "a",
          description: "finished",
          status: "done",
          currentToolStartedAt: null,
          finishedAt: NOW - 1_000,
        },
        {
          agentId: "b",
          description: "failed",
          status: "failed",
          currentToolStartedAt: null,
          finishedAt: NOW - 500,
        },
      ],
      undefined,
      NOW,
    );
    expect(rows).toEqual([
      {
        label: "! b  failed",
        tail: " · failed",
        stalled: true,
        kind: "lane",
        status: "failed",
      },
      {
        label: "● a  finished",
        tail: " · done",
        stalled: false,
        kind: "lane",
        status: "done",
      },
    ]);
  });

  test("linger expires — terminal rows drop after the window", () => {
    expect(
      formatAgentsPanel(
        [
          {
            agentId: "a",
            description: "old",
            status: "done",
            currentToolStartedAt: null,
            finishedAt: NOW - AGENTS_PANEL_LINGER_MS,
          },
        ],
        undefined,
        NOW,
      ),
    ).toBeNull();
  });

  test("a stalled lane uses ! marker and reports silence via the clock", () => {
    const rows = formatAgentsPanel(
      [
        {
          agentId: "a",
          currentToolStartedAt: null,
          description: "quiet worker",
          status: "running",
          startedAt: NOW - 180_000,
          lastActivityAt: NOW - 310_000,
        },
      ],
      undefined,
      NOW,
    );
    expect(rows).toEqual([
      {
        label: "! a  quiet worker",
        tail: " · 3:00",
        stalled: true,
        kind: "lane",
        status: "running",
      },
    ]);
  });

  test("trouble sorts above routine progress", () => {
    const rows = formatAgentsPanel(
      [
        {
          agentId: "fine",
          description: "busy",
          status: "running",
          currentToolStartedAt: null,
          startedAt: NOW - 1_000,
          lastActivityAt: NOW,
        },
        {
          agentId: "quiet",
          description: "silent",
          status: "running",
          currentToolStartedAt: null,
          startedAt: NOW - 180_000,
          lastActivityAt: NOW - 310_000,
        },
      ],
      undefined,
      NOW,
    );
    // Labels are `● id  desc` / `! id  desc` — second token is the agentId.
    expect(rows?.map((r) => r.label.split(/\s+/)[1])).toEqual(["quiet", "fine"]);
  });

  test("bounds fan-out and says how many lanes it is hiding", () => {
    const running = Array.from({ length: 8 }, (_, i) => ({
      agentId: `agent-${i}`,
      currentToolStartedAt: null,
      description: "working",
      status: "running" as const,
      startedAt: NOW + i,
      lastActivityAt: NOW,
    }));
    const rows = formatAgentsPanel(running, undefined, NOW, 6);
    // maxVisible lanes + trailing +N more
    expect(rows).toHaveLength(7);
    expect(rows?.[6]).toEqual({
      label: "+2 more",
      tail: "",
      stalled: false,
      kind: "more",
    });
  });

  test("default max paints 10 lanes plus +N more under overflow", () => {
    const running = Array.from({ length: 13 }, (_, i) => ({
      agentId: `agent-${i}`,
      currentToolStartedAt: null,
      description: "working",
      status: "running" as const,
      startedAt: NOW + i,
      lastActivityAt: NOW,
    }));
    const rows = formatAgentsPanel(running, undefined, NOW);
    expect(rows).toHaveLength(11);
    expect(rows?.filter((r) => r.kind === "lane")).toHaveLength(10);
    expect(rows?.[10]).toEqual({
      label: "+3 more",
      tail: "",
      stalled: false,
      kind: "more",
    });
  });

  test("overflow always reserves a +N more disclosure row", () => {
    const running = Array.from({ length: 8 }, (_, i) => ({
      agentId: `agent-${i}`,
      currentToolStartedAt: null,
      description: "working",
      status: "running" as const,
      startedAt: NOW + i,
      lastActivityAt: NOW,
    }));
    const rows = formatAgentsPanel(running, undefined, NOW, 3);
    expect(rows).toHaveLength(4);
    expect(rows?.[3]).toEqual({
      label: "+5 more",
      tail: "",
      stalled: false,
      kind: "more",
    });
    expect(rows?.some((r) => r.kind === "header")).toBe(false);
  });

  test("observe empty id+desc hides", () => {
    expect(formatAgentsPanel([], { agentId: "  ", description: "  " }, NOW)).toBeNull();
  });

  test("row order is stable across an activity update between frames", () => {
    // Neither sort key churns: a lane's state changes only when something real
    // happens to it, and startedAt never changes at all. Keying on
    // lastActivityAt would reshuffle the board on every tool event.
    const frame1 = [
      {
        agentId: "b",
        description: "second",
        status: "running" as const,
        currentToolStartedAt: null,
        startedAt: NOW - 1_000,
        lastActivityAt: NOW - 1_000,
      },
      {
        agentId: "a",
        description: "first",
        status: "running" as const,
        currentToolStartedAt: null,
        startedAt: NOW - 2_000,
        lastActivityAt: NOW - 2_000,
      },
      {
        agentId: "c",
        description: "third",
        status: "running" as const,
        currentToolStartedAt: null,
        startedAt: NOW - 500,
        lastActivityAt: NOW - 500,
      },
    ];
    const rowsBefore = formatAgentsPanel(frame1, undefined, NOW);

    const frame2 = frame1.map((a) => (a.agentId === "b" ? { ...a, lastActivityAt: NOW + 200 } : a));
    const rowsAfter = formatAgentsPanel(frame2, undefined, NOW + 200);

    const ids = (rows: ReturnType<typeof formatAgentsPanel>) =>
      rows?.map((r) => r.label.split(/\s+/)[1]);
    expect(ids(rowsBefore)).toEqual(ids(rowsAfter));
    expect(ids(rowsBefore)).toEqual(["a", "b", "c"]);
  });

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
    }));
    const stalled = {
      agentId: "quiet",
      currentToolStartedAt: null,
      description: "gone silent",
      status: "running" as const,
      startedAt: NOW - 360_000,
      lastActivityAt: NOW - 310_000,
    };
    const rows = formatAgentsPanel([...newest, stalled], undefined, NOW, 4);
    // 4 lanes + more (maxVisible lanes kept; fold is an extra row)
    expect(rows).toHaveLength(5);
    expect(rows?.[0]?.label.split(/\s+/)[1]).toBe("quiet");
    expect(rows?.[0]?.stalled).toBe(true);
    expect(rows?.[4]?.kind).toBe("more");
  });
});

describe("chromeFromSession", () => {
  test("maps tasks / agents loosely", () => {
    const state = chromeFromSession({
      tasks: [
        { title: "wire catalogs", status: "doing" },
        { title: "export index", status: "todo" },
      ],
      agents: [
        {
          agentId: "explorer",
          currentToolStartedAt: null,
          description: "map callers",
          status: "running",
          currentToolName: "grep",
          // Clocks so the strip can paint elapsed / stall from agentProgress.
          startedAt: NOW - 5_000,
          lastActivityAt: NOW,
        },
      ],
    });

    expect(state.task).toEqual([
      { title: "wire catalogs", status: "doing" },
      { title: "export index", status: "todo" },
    ]);
    expect(state.agents).toEqual([
      {
        agentId: "explorer",
        currentToolStartedAt: null,
        description: "map callers",
        status: "running",
        currentToolName: "grep",
        startedAt: NOW - 5_000,
        lastActivityAt: NOW,
      },
    ]);

    const zones = formatChromeZones(state, NOW);
    expect(zones.task).toBeNull();
    expect(zones.agents).not.toBeNull();
    expect(zones.agents?.[0]?.label).toContain("explorer");
  });

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
    });
    expect(state.task).toBeNull();
    expect(state.agents?.[0]?.agentId).toBe("sess-1");
  });

  test("observe passes through and paints the agents strip", () => {
    const state = chromeFromSession({
      observe: { agentId: "explorer", description: "watch" },
    });
    expect(state.observe).toEqual({
      agentId: "explorer",
      description: "watch",
    });
    expect(formatChromeZones(state, NOW).agents).toEqual([
      {
        label: "observe: explorer — watch",
        tail: "",
        stalled: false,
        kind: "lane",
        status: "running",
      },
    ]);
  });
});

describe("annotateAgentTools", () => {
  const state: ChromeLiveState = {
    agents: [
      {
        agentId: "explorer",
        description: "map callers",
        status: "running",
        currentToolStartedAt: null,
      },
      { agentId: "review", description: "map callers", status: "done", currentToolStartedAt: null },
    ],
  };

  test("is an identity: a progress map never paints a tool without a store clock", () => {
    // The store is the sole source of truth for what a worker is doing.
    // A progress ping carries only a tool name with no clock, and is also
    // emitted on tool completion, so it must never fill in a dead lane.
    const tools = new Map([["map callers", "grep"]]);
    expect(annotateAgentTools(state, tools)).toBe(state);
    expect(annotateAgentTools(state, new Map())).toBe(state);
  });
});

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
    // Past DEFAULT_STALL_MS (300s) so laneState reaches the in_tool branch,
    // still under IN_TOOL_STALL_MS (10 min). Tool clock stays at 3:00.
    currentToolStartedAt: NOW - 180_000,
    startedAt: NOW - 200_000,
    lastActivityAt: NOW - 310_000,
  };

  test("the panel and the transcript row agree that the lane is in a tool", () => {
    expect(laneState(inTool, NOW)).toBe("in_tool");

    const rows = formatAgentsPanel(chromeFromSession({ agents: [inTool] }).agents, undefined, NOW);
    // Flat strip: one lane row, no FLEET header.
    expect(rows?.[0]?.kind).toBe("lane");
    expect(rows?.[0]?.stalled).toBe(false);
    expect(rows?.[0]?.label.startsWith("● ")).toBe(true);
    expect(rows?.[0]?.tail).toContain("run_shell 3:00");
    expect(rows?.[0]?.tail).not.toContain("stalled");
    expect(rows?.some((r) => r.kind === "header")).toBe(false);

    expect(agentProgress(inTool, NOW)?.stat).toContain("run_shell 3:00");
  });

  test("a shell preview replaces the tool name on both panel and trailer (CL-5765)", () => {
    const withPreview = {
      ...inTool,
      currentToolPreview: "bun test ./src",
    };
    const rows = formatAgentsPanel(
      chromeFromSession({ agents: [withPreview] }).agents,
      undefined,
      NOW,
    );
    expect(rows?.[0]?.tail).toContain("bun test ./src");
    expect(rows?.[0]?.tail).not.toContain("run_shell");
    expect(agentProgress(withPreview, NOW)?.stat).toContain("bun test ./src");
    expect(agentProgress(withPreview, NOW)?.stat).not.toContain("run_shell");
  });

  test("a genuinely silent lane still reads stalled through the same hops", () => {
    const silent = {
      ...inTool,
      currentToolName: null,
      currentToolStartedAt: null,
      lastActivityAt: NOW - 310_000,
    };
    expect(laneState(silent, NOW)).toBe("stalled");

    const rows = formatAgentsPanel(chromeFromSession({ agents: [silent] }).agents, undefined, NOW);
    expect(rows?.[0]?.kind).toBe("lane");
    expect(rows?.[0]?.stalled).toBe(true);
    expect(rows?.[0]?.label.startsWith("! ")).toBe(true);
    expect(rows?.some((r) => r.kind === "header")).toBe(false);
  });

  // A progress ping renames the tool but carries no clock of its own and may
  // arrive on tool completion — so it must not paint anything at all.
  test("the tool annotation never repaints a live call with another name", () => {
    const annotated = annotateAgentTools({ agents: [inTool] }, new Map([["sleep 150", "grep"]]));
    expect(annotated.agents?.[0]?.currentToolName).toBe("run_shell");
    expect(annotated.agents?.[0]?.currentToolStartedAt).toBe(NOW - 180_000);
  });

  test("the tool annotation never fills a gap when no call is outstanding", () => {
    // A lane with no outstanding call must stay null: the progress map is not
    // a source of truth for what a worker is doing. Painting it here is what
    // produced the false "quiet … · <tool>" stall on finished tools.
    const idle = { ...inTool, currentToolName: null, currentToolStartedAt: null };
    const annotated = annotateAgentTools({ agents: [idle] }, new Map([["sleep 150", "grep"]]));
    expect(annotated.agents?.[0]?.currentToolName).toBeNull();
    expect(annotated.agents?.[0]?.currentToolStartedAt).toBeNull();
  });

  test("a stalled lane with a null tool clock is marked ! with no tool name", () => {
    // Inference-wait silence: flat strip uses ! marker; agentProgress never
    // gap-fills a tool subject.
    const silent = {
      ...inTool,
      currentToolName: null,
      currentToolPreview: null,
      currentToolStartedAt: null,
      lastActivityAt: NOW - 310_000,
    };
    const rows = formatAgentsPanel(chromeFromSession({ agents: [silent] }).agents, undefined, NOW);
    expect(rows?.[0]?.stalled).toBe(true);
    expect(rows?.[0]?.label.startsWith("! ")).toBe(true);
    expect(rows?.[0]?.tail).not.toContain("grep");
    expect(agentProgress(silent, NOW)?.stat).not.toContain("quiet");
    expect(agentProgress(silent, NOW)?.stat).not.toContain("grep");
    expect(agentProgress(silent, NOW)?.stat).not.toContain("read_file");
  });
});

describe("clampBoardRows", () => {
  test("carries a prior more-row count into a tighter re-clamp", () => {
    // Formatter already hid 4 of 8; collapse then grants only 4 rows total.
    // Honest disclosure is 4 prior + 1 newly dropped = 5 (3 lanes + fold).
    const formatted = [
      { label: "● a  one", tail: " · 0:01", stalled: false, kind: "lane" as const },
      { label: "● b  two", tail: " · 0:01", stalled: false, kind: "lane" as const },
      { label: "● c  three", tail: " · 0:01", stalled: false, kind: "lane" as const },
      { label: "● d  four", tail: " · 0:01", stalled: false, kind: "lane" as const },
      { label: "+4 more", tail: "", stalled: false, kind: "more" as const },
    ];
    const clamped = clampBoardRows(formatted, 4);
    expect(clamped).toHaveLength(4);
    expect(clamped[0]?.kind).toBe("lane");
    expect(clamped[3]).toEqual({
      label: "+5 more",
      tail: "",
      stalled: false,
      kind: "more",
    });
  });

  test("under a tight height the fold still discloses total hidden", () => {
    const formatted = [
      { label: "● a  one", tail: " · 0:01", stalled: false, kind: "lane" as const },
      { label: "● b  two", tail: " · 0:01", stalled: false, kind: "lane" as const },
      { label: "+4 more", tail: "", stalled: false, kind: "more" as const },
    ];
    const clamped = clampBoardRows(formatted, 2);
    expect(clamped).toHaveLength(2);
    // 4 prior + 1 newly dropped lane = 5.
    expect(clamped[1]).toEqual({
      label: "+5 more",
      tail: "",
      stalled: false,
      kind: "more",
    });
  });
});
