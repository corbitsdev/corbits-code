import { describe, expect, test } from "bun:test";

import {
  activeStripSessions,
  agentsStripRowColor,
  agentsStripRowCount,
  computeAgentsStripWindow,
  DEFAULT_STRIP_MAX_VISIBLE,
  formatSessionLabel,
  mergeInFlightSubAgents,
  orderStripSessions,
  shouldShowAgentsStrip,
} from "../../../src/tui/components/agents-strip.js";
import type { Task } from "../../../src/agent/tasks.js";
import type {
  SubAgentSession,
  SubAgentSessionStatus,
  SubAgentTranscriptEntry,
} from "../../../src/subagent/session-store.js";
import { color } from "../../../src/tui/theme.js";

describe("agentsStripRowCount", () => {
  test("no sessions reserves no rows", () => {
    expect(agentsStripRowCount(0, DEFAULT_STRIP_MAX_VISIBLE)).toBe(0);
  });

  test("below the cap reserves header plus one row per session", () => {
    expect(agentsStripRowCount(3, DEFAULT_STRIP_MAX_VISIBLE)).toBe(1 + 3);
  });

  test("above the cap stays bounded and adds a single overflow row", () => {
    // 20 retained sessions must not reserve 20 rows; the strip caps and folds
    // the remainder into one overflow line.
    expect(agentsStripRowCount(20, DEFAULT_STRIP_MAX_VISIBLE)).toBe(
      1 + DEFAULT_STRIP_MAX_VISIBLE + 1,
    );
  });
});

describe("computeAgentsStripWindow", () => {
  test("centers the selection when browsing a long list", () => {
    const w = computeAgentsStripWindow(30, 20, DEFAULT_STRIP_MAX_VISIBLE);
    expect(w.start).toBeLessThanOrEqual(20);
    expect(w.end - w.start).toBe(DEFAULT_STRIP_MAX_VISIBLE);
    expect(w.hiddenBelow).toBe(30 - w.end);
  });
});

describe("activeStripSessions", () => {
  const session = (id: string, status: SubAgentSessionStatus): SubAgentSession => ({
    id,
    description: id,
    agentId: "agent",
    brief: "",
    status,
    toolNames: [],
    currentToolName: null,
    entries: [],
    startedAt: 0,
  });

  test("keeps only running sessions, dropping done, failed, and cancelled", () => {
    const sessions = [
      session("live", "running"),
      session("finished", "done"),
      session("broke", "failed"),
      session("killed", "cancelled"),
    ];

    expect(activeStripSessions(sessions).map((s) => s.id)).toEqual(["live"]);
  });

  test("returns nothing once every session is terminal", () => {
    expect(
      activeStripSessions([
        session("a", "done"),
        session("b", "failed"),
        session("c", "cancelled"),
      ]),
    ).toEqual([]);
  });

  test("reports N running sessions in the chrome strip while all are active", () => {
    const n = 5;
    const running = activeStripSessions(
      Array.from({ length: n }, (_, i) => session(`worker-${i}`, "running")),
    );
    expect(running).toHaveLength(n);
    expect(running.map((s) => s.id)).toEqual(
      Array.from({ length: n }, (_, i) => `worker-${i}`),
    );
  });
});

describe("mergeInFlightSubAgents", () => {
  const session = (id: string, status: SubAgentSessionStatus): SubAgentSession => ({
    id,
    description: id,
    agentId: "agent",
    brief: "",
    status,
    toolNames: [],
    currentToolName: null,
    entries: [],
    startedAt: 0,
  });

  test("surfaces N parallel sub-agents from parent stream when the store is empty", () => {
    const tasks: Task[] = Array.from({ length: 3 }, (_, i) => ({
      id: `call-${i}`,
      title: `worker: job ${i}`,
      status: "doing",
    }));
    const chrome = activeStripSessions(mergeInFlightSubAgents([], tasks));
    expect(chrome).toHaveLength(3);
    expect(chrome.map((s) => s.id)).toEqual(["call-0", "call-1", "call-2"]);
  });

  test("keeps the session-store row when the same id is already running", () => {
    const store = [{ ...session("call-1", "running"), description: "from store" }];
    const tasks: Task[] = [{ id: "call-1", title: "worker: from task", status: "doing" }];
    const merged = mergeInFlightSubAgents(store, tasks);
    expect(merged.find((s) => s.id === "call-1")?.description).toBe("from store");
  });

  test("does not resurrect a terminal store session when parent task still shows doing", () => {
    const store = [session("call-1", "done")];
    const tasks: Task[] = [{ id: "call-1", title: "worker: lagging", status: "doing" }];
    const chrome = activeStripSessions(mergeInFlightSubAgents(store, tasks));
    expect(chrome).toHaveLength(0);
  });

  test("parses tool suffix from live progress titles", () => {
    const tasks: Task[] = [
      { id: "c1", title: "researcher: scan repo · grep", status: "doing" },
    ];
    const chrome = activeStripSessions(mergeInFlightSubAgents([], tasks));
    expect(chrome[0]?.currentToolName).toBe("grep");
    expect(chrome[0]?.agentId).toBe("researcher");
  });

  test("keeps nested children adjacent under their parent after merge", () => {
    const store: SubAgentSession[] = [
      { ...session("child-b", "running"), parentSessionId: "orch", startedAt: 3 },
      { ...session("solo", "running"), startedAt: 2 },
      { ...session("orch", "running"), startedAt: 1 },
      { ...session("child-a", "running"), parentSessionId: "orch", startedAt: 4 },
    ];
    const ordered = mergeInFlightSubAgents(store, []).map((s) => s.id);
    // Newest root first (solo @2 over orch @1), then orch's children by recency.
    expect(ordered).toEqual(["solo", "orch", "child-a", "child-b"]);
  });
});

describe("orderStripSessions", () => {
  const session = (
    id: string,
    status: SubAgentSessionStatus,
    startedAt: number,
    parentSessionId?: string,
  ): SubAgentSession => ({
    id,
    description: id,
    agentId: "agent",
    brief: "",
    status,
    toolNames: [],
    currentToolName: null,
    entries: [],
    startedAt,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
  });

  test("groups one-hop children under their parent for tree glyphs", () => {
    const ordered = orderStripSessions([
      session("leaf-2", "running", 30, "parent"),
      session("other", "running", 20),
      session("parent", "running", 10),
      session("leaf-1", "done", 40, "parent"),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["other", "parent", "leaf-2", "leaf-1"]);
  });

  test("treats orphan parentSessionId as a root when parent is absent", () => {
    const ordered = orderStripSessions([
      session("orphan", "running", 5, "missing"),
      session("root", "running", 1),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(["orphan", "root"]);
  });
});

describe("shouldShowAgentsStrip", () => {
  const running = (id: string): SubAgentSession => ({
    id,
    description: id,
    agentId: "agent",
    brief: "",
    status: "running",
    toolNames: [],
    currentToolName: null,
    entries: [],
    startedAt: 0,
  });

  test("shows chrome when at least one running worker is visible", () => {
    expect(
      shouldShowAgentsStrip({
        chromeSessions: [running("a")],
        browseSessions: [],
        agentsNavOpen: false,
      }),
    ).toBe(true);
  });

  test("hides chrome when idle and agents-nav is closed", () => {
    expect(
      shouldShowAgentsStrip({
        chromeSessions: [],
        browseSessions: [],
        agentsNavOpen: false,
      }),
    ).toBe(false);
  });
});

describe("formatSessionLabel", () => {
  const baseSession = (overrides: Partial<SubAgentSession> = {}): SubAgentSession => ({
    id: "s1",
    description: "researching things",
    agentId: "researcher",
    brief: "",
    status: "running",
    toolNames: [],
    currentToolName: null,
    entries: [],
    startedAt: 0,
    ...overrides,
  });

  test("shows a tool argument preview while a tool call is in flight", () => {
    const entries: SubAgentTranscriptEntry[] = [
      { kind: "tool", callId: "c1", name: "grep", arguments: '{"pattern":"foo","path":"src/tui"}' },
    ];
    const session = baseSession({ currentToolName: "grep", entries });
    expect(formatSessionLabel(session)).toContain("researcher: researching things — grep");
  });

  test("falls back to the bare tool name when no argument summary is available", () => {
    const session = baseSession({ currentToolName: "manage_tasks", entries: [] });
    expect(formatSessionLabel(session)).toBe(
      "researcher: researching things — manage_tasks",
    );
  });

  test("clears the tool preview once the session is no longer running", () => {
    const session = baseSession({
      status: "done",
      currentToolName: null,
      toolNames: ["grep", "read_file"],
    });
    expect(formatSessionLabel(session)).toBe("researcher: researching things · 2 tools");
  });

  test("shell tool preview leads with the command, not a redundant tool name", () => {
    const entries: SubAgentTranscriptEntry[] = [
      { kind: "tool", callId: "c1", name: "run_shell", arguments: '{"command":"bun test"}' },
    ];
    const session = baseSession({ currentToolName: "run_shell", entries });
    expect(formatSessionLabel(session)).toBe("researcher: researching things — bun test");
  });
});

describe("agentsStripRowColor", () => {
  test("status colours survive without glyphs; selection uses text", () => {
    expect(agentsStripRowColor("running", { selected: false, entered: false })).toBe(color("text"));
    expect(agentsStripRowColor("done", { selected: false, entered: false })).toBe(color("success"));
    expect(agentsStripRowColor("failed", { selected: false, entered: false })).toBe(color("danger"));
    expect(agentsStripRowColor("cancelled", { selected: false, entered: false })).toBe(color("muted"));
    // Focus overrides status so the cursor/observe row stays readable.
    expect(agentsStripRowColor("failed", { selected: true, entered: false })).toBe(color("text"));
    expect(agentsStripRowColor("done", { selected: false, entered: true })).toBe(color("text"));
  });
});


