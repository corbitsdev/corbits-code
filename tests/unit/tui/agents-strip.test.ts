import { describe, expect, test } from "bun:test";

import {
  activeStripSessions,
  agentsStripRowCount,
  DEFAULT_STRIP_MAX_VISIBLE,
  formatSessionLabel,
} from "../../../src/tui/components/agents-strip.js";
import type {
  SubAgentSession,
  SubAgentSessionStatus,
  SubAgentTranscriptEntry,
} from "../../../src/subagent/session-store.js";

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
