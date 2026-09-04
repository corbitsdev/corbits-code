import { describe, expect, test } from "bun:test";
import {
  agentLaneIsLive,
  agentProgress,
  clockLabel,
  fleetLabel,
  fleetProgress,
  laneState,
  IN_TOOL_STALL_MS,
} from "./agent-progress";

describe("clockLabel", () => {
  test("formats sub-minute and multi-minute elapsed as m:ss", () => {
    expect(clockLabel(0)).toBe("0:00");
    expect(clockLabel(42_000)).toBe("0:42");
    expect(clockLabel(90_000)).toBe("1:30");
  });
});

describe("agentProgress", () => {
  const base = {
    status: "running" as const,
    currentToolName: "grep",
    currentToolPreview: null as string | null,
    currentToolStartedAt: null as number | null,
    startedAt: 0,
    lastActivityAt: 0,
  };

  test("terminal sessions have no pending-row progress", () => {
    expect(agentProgress({ ...base, status: "done" }, 1000)).toBeNull();
    expect(agentProgress({ ...base, status: "failed" }, 1000)).toBeNull();
    expect(agentProgress({ ...base, status: "cancelled" }, 1000)).toBeNull();
  });

  test("an interrupted running session names leftover tools instead of looking busy", () => {
    const progress = agentProgress(
      {
        ...base,
        lifecycleStatus: "interrupted",
        currentToolName: "run_shell",
        currentToolPreview: "bun test",
        currentToolStartedAt: 1_000,
        lastActivityAt: 1_000,
      },
      91_000,
    );
    expect(progress?.stat).toBe("interrupted · bun test still running");
    expect(progress?.working).toBe(false);
    expect(progress?.stalled).toBe(false);
  });

  test("an interrupted session with no leftover tool shows plain interrupted", () => {
    const progress = agentProgress(
      {
        ...base,
        lifecycleStatus: "interrupted",
        currentToolName: null,
        currentToolPreview: null,
        currentToolStartedAt: null,
        lastActivityAt: 1_000,
      },
      91_000,
    );
    expect(progress?.stat).toBe("interrupted");
    expect(progress?.stat).not.toContain("still running");
    expect(progress?.working).toBe(false);
    expect(progress?.stalled).toBe(false);
  });

  test("a running session reports elapsed time and its current tool", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 42_000 }, 42_000);
    expect(progress).toEqual({
      stat: "0:42 · grep",
      state: "working",
      working: true,
      stalled: false,
    });
  });

  test("a tool preview replaces the bare tool name in the trailer (CL-5765)", () => {
    const progress = agentProgress(
      {
        ...base,
        currentToolName: "run_shell",
        currentToolPreview: "bun test ./src",
        currentToolStartedAt: 1_000,
        lastActivityAt: 1_000,
      },
      91_000,
      30_000,
    );
    expect(progress?.stat).toBe("1:31 · bun test ./src 1:30");
    expect(progress?.stat).not.toContain("run_shell");
  });

  test("without a preview the trailer still names the tool", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 42_000 }, 42_000);
    expect(progress?.stat).toContain("grep");
  });

  test("a running session with no current tool reports elapsed time alone", () => {
    const progress = agentProgress(
      { ...base, currentToolName: null, lastActivityAt: 42_000 },
      42_000,
    );
    expect(progress).toEqual({
      stat: "0:42",
      state: "working",
      working: true,
      stalled: false,
    });
  });

  test("silence with no tool outstanding is a stall, and the clock shown is the silence", () => {
    const progress = agentProgress(
      { ...base, currentToolName: null, lastActivityAt: 0 },
      121_000,
      120_000,
    );
    expect(progress).toEqual({
      stat: "2:01",
      state: "stalled",
      working: false,
      stalled: true,
    });
  });

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
      181_000,
      120_000,
    );
    expect(progress?.state).toBe("in_tool");
    expect(progress?.stalled).toBe(false);
    expect(progress?.stat).toBe("3:01 · run_shell 3:00");
  });

  test("recent activity keeps a long-running session marked working", () => {
    const progress = agentProgress({ ...base, lastActivityAt: 100_000 }, 100_500, 120_000);
    expect(progress?.working).toBe(true);
    expect(progress?.stalled).toBe(false);
  });

  test("default stall window tolerates a multi-minute Grok think gap", () => {
    // DEFAULT_STALL_MS is 300s — 180s of quiet with no tool outstanding must
    // still read working, or worker/spawn_agent rows false-stall on healthy Responses thinks.
    const progress = agentProgress({ ...base, currentToolName: null, lastActivityAt: 0 }, 180_000);
    expect(progress?.state).toBe("working");
    expect(progress?.stalled).toBe(false);
    expect(
      agentProgress({ ...base, currentToolName: null, lastActivityAt: 0 }, 301_000)?.stalled,
    ).toBe(true);
  });

  test("an ask_director lane names waiting on the director and is not stalled", () => {
    const progress = agentProgress(
      {
        ...base,
        currentToolName: "ask_director",
        currentToolStartedAt: 0,
        lastActivityAt: 0,
      },
      IN_TOOL_STALL_MS + 1_000,
    );
    expect(progress?.stalled).toBe(false);
    expect(progress?.working).toBe(true);
    expect(progress?.state).toBe("in_tool");
    expect(progress?.stat).toContain("ask_director");
    expect(progress?.stat).toContain("waiting on director");
  });
});

describe("laneState", () => {
  const running = {
    status: "running" as const,
    currentToolName: null as string | null,
    currentToolPreview: null as string | null,
    currentToolStartedAt: null as number | null,
    startedAt: 0,
    lastActivityAt: 0,
  };

  test("names the three lanes a running worker can be in", () => {
    expect(laneState({ ...running, lastActivityAt: 1_000 }, 2_000, 30_000)).toBe("working");
    expect(laneState(running, 60_000, 30_000)).toBe("stalled");
    expect(
      laneState(
        { ...running, currentToolName: "run_shell", currentToolStartedAt: 0 },
        60_000,
        30_000,
      ),
    ).toBe("in_tool");
  });
});

describe("fleetProgress", () => {
  const lane = (over: Partial<Parameters<typeof laneState>[0]>) => ({
    status: "running" as const,
    currentToolName: null as string | null,
    currentToolPreview: null as string | null,
    currentToolStartedAt: null as number | null,
    startedAt: 0,
    lastActivityAt: 0,
    ...over,
  });

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
    );
    expect(fleet).toEqual({ running: 3, working: 1, inTool: 1, stalled: 1 });
  });

  test("no sub-agents leaves the fleet empty", () => {
    expect(fleetProgress([], 1_000)).toEqual({
      running: 0,
      working: 0,
      inTool: 0,
      stalled: 0,
    });
  });

  test("does not count interrupted running leftover tools", () => {
    const fleet = fleetProgress(
      [
        lane({ lastActivityAt: 59_000 }),
        lane({
          lifecycleStatus: "interrupted",
          currentToolName: "run_shell",
          currentToolStartedAt: 0,
          lastActivityAt: 0,
        }),
      ],
      60_000,
      30_000,
    );
    expect(fleet).toEqual({ running: 1, working: 1, inTool: 0, stalled: 0 });
  });
});

describe("agentLaneIsLive", () => {
  test("running without lifecycleStatus stays live; interrupted is not", () => {
    expect(agentLaneIsLive({ status: "running" })).toBe(true);
    expect(agentLaneIsLive({ status: "running", lifecycleStatus: "running" })).toBe(true);
    expect(agentLaneIsLive({ status: "running", lifecycleStatus: "interrupted" })).toBe(false);
    expect(agentLaneIsLive({ status: "done" })).toBe(false);
  });
});

describe("fleetLabel", () => {
  test("is null with nothing running so the single-agent case is untouched", () => {
    expect(fleetLabel({ running: 0, working: 0, inTool: 0, stalled: 0 })).toBeNull();
  });

  test("never names stalled count to the operator", () => {
    expect(fleetLabel({ running: 6, working: 4, inTool: 0, stalled: 2 })).toBe("6 agents");
  });

  test("says when the whole fleet is inside tool calls", () => {
    expect(fleetLabel({ running: 3, working: 0, inTool: 3, stalled: 0 })).toBe(
      "3 agents · in tools",
    );
  });
});

describe("the in-tool bound", () => {
  const wedged = {
    status: "running" as const,
    currentToolName: "run_shell",
    currentToolPreview: null as string | null,
    currentToolStartedAt: 0,
    startedAt: 0,
    lastActivityAt: 0,
  };

  // in_tool must not be terminal, or a wedged build reads as busy forever and
  // never reaches the fleet stall count.
  test("a call outstanding past the bound escalates to stalled", () => {
    expect(laneState(wedged, IN_TOOL_STALL_MS - 1_000)).toBe("in_tool");
    expect(laneState(wedged, IN_TOOL_STALL_MS + 1_000)).toBe("stalled");
  });

  test("ask_director past the in-tool bound stays in_tool, never stalled", () => {
    const asking = { ...wedged, currentToolName: "ask_director" };
    expect(laneState(asking, IN_TOOL_STALL_MS + 1_000)).toBe("in_tool");
    expect(fleetProgress([asking], IN_TOOL_STALL_MS + 1_000)).toEqual({
      running: 1,
      working: 0,
      inTool: 1,
      stalled: 0,
    });
  });

  test("an escalated lane counts toward the fleet stall count", () => {
    expect(fleetProgress([wedged], IN_TOOL_STALL_MS + 1_000)).toEqual({
      running: 1,
      working: 0,
      inTool: 0,
      stalled: 1,
    });
  });
});
