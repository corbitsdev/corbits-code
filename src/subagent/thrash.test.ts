import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THRASH_CONFIG,
  EMPTY_THRASH_STATE,
  evaluateThrashStop,
  nextThrashState,
  thrashForceReport,
  type ThrashState,
  type ThrashToolCallBlock,
} from "./thrash.js";

function read(path: string, extra: Record<string, unknown> = {}): ThrashToolCallBlock {
  return { type: "tool_call", name: "read_file", arguments: { path, ...extra } };
}

function edit(path: string): ThrashToolCallBlock {
  return {
    type: "tool_call",
    name: "edit_file",
    arguments: { path, old_string: "a", new_string: "b" },
  };
}

function write(path: string): ThrashToolCallBlock {
  return { type: "tool_call", name: "write_file", arguments: { path, content: "x" } };
}

function del(path: string): ThrashToolCallBlock {
  return { type: "tool_call", name: "delete_file", arguments: { path } };
}

function grep(pattern: string): ThrashToolCallBlock {
  return { type: "tool_call", name: "grep", arguments: { pattern, path: "src" } };
}

function applyAll(calls: readonly ThrashToolCallBlock[]): ThrashState {
  return nextThrashState(EMPTY_THRASH_STATE, calls);
}

describe("thrash pure module", () => {
  test("defaults keep only the near-budget wrap-up threshold", () => {
    expect(DEFAULT_THRASH_CONFIG.forceReportWithin).toBe(2);
    expect(Object.keys(DEFAULT_THRASH_CONFIG)).toEqual(["forceReportWithin"]);
  });

  test("re-read pressure is never a stop, at any count (CL-6936)", () => {
    const path = "src/subagent/index.ts";
    const calls: ThrashToolCallBlock[] = [edit(path)];
    for (let i = 0; i < 12; i++) calls.push(read(path));
    for (let i = 0; i < 8; i++) calls.push(grep(`p${String(i)}`));
    const state = applyAll(calls);
    expect(state.readCounts.get(path)).toBe(12);
    expect(evaluateThrashStop({ hasToolCalls: true, turnsCompleted: 3, maxTurns: 25 })).toBeNull();
  });

  test("write_file, delete_file, and apply_patch mark paths as edited", () => {
    const patch = {
      type: "tool_call",
      name: "apply_patch",
      arguments: {
        input: "*** Begin Patch\n*** Update File: c.ts\n@@\n-old\n+new\n*** End Patch\n",
      },
    } satisfies ThrashToolCallBlock;
    const state = applyAll([write("a.ts"), del("b.ts"), patch]);
    expect(state.editedPaths.has("a.ts")).toBe(true);
    expect(state.editedPaths.has("b.ts")).toBe(true);
    expect(state.editedPaths.has("c.ts")).toBe(true);
  });

  test("near-budget force-report fires once, leaving turn-budget reachable", () => {
    // maxTurns=10, forceReportWithin=2 → single nudge at turnsCompleted === 8.
    expect(thrashForceReport(7, 10, true)).toBe(false);
    expect(thrashForceReport(8, 10, true)).toBe(true);
    expect(thrashForceReport(9, 10, true)).toBe(false);
    expect(thrashForceReport(10, 10, true)).toBe(false);
    // No tools this turn → not force-report (tool-less turns are complete).
    expect(thrashForceReport(8, 10, false)).toBe(false);

    expect(evaluateThrashStop({ hasToolCalls: true, turnsCompleted: 8, maxTurns: 10 })).toBe(
      "report-forced",
    );
    expect(evaluateThrashStop({ hasToolCalls: true, turnsCompleted: 7, maxTurns: 10 })).toBeNull();
    // Turn-budget remains reachable after the single nudge turn.
    expect(evaluateThrashStop({ hasToolCalls: true, turnsCompleted: 9, maxTurns: 10 })).toBeNull();
    expect(evaluateThrashStop({ hasToolCalls: true, turnsCompleted: 10, maxTurns: 10 })).toBeNull(); // turn-budget is the caller's job.
  });

  test("small maxTurns degrades gracefully instead of collapsing to a single turn", () => {
    expect(thrashForceReport(1, 1, true)).toBe(false);
    expect(thrashForceReport(1, 2, true)).toBe(false);
    expect(thrashForceReport(2, 2, true)).toBe(false);
    expect(thrashForceReport(1, 3, true)).toBe(true);
    expect(thrashForceReport(2, 3, true)).toBe(false);
    expect(thrashForceReport(3, 3, true)).toBe(false);
  });

  test("tool-less turns never return a stop reason", () => {
    expect(
      evaluateThrashStop({ hasToolCalls: false, turnsCompleted: 23, maxTurns: 25 }),
    ).toBeNull();
  });

  test("nextThrashState is pure and accumulates across turns", () => {
    let state = EMPTY_THRASH_STATE;
    state = nextThrashState(state, [read("a.ts")]);
    // An edit no longer erases read evidence: readCounts is the requireEvidence
    // record, not a thrash counter (CL-6936).
    state = nextThrashState(state, [edit("a.ts")]);
    expect(state.readCounts.get("a.ts")).toBe(1);
    state = nextThrashState(state, [read("a.ts"), read("a.ts")]);
    expect(state.readCounts.get("a.ts")).toBe(3);
    expect(state.editedPaths.has("a.ts")).toBe(true);
    expect(state.totalToolCalls).toBe(4);
  });

  test("nextThrashState ignores non-tool blocks and normalizes JSON-string args", () => {
    const state = nextThrashState(EMPTY_THRASH_STATE, [
      { type: "text", name: "ignored" },
      {
        type: "tool_call",
        name: "read_file",
        arguments: JSON.stringify({ path: "a.ts" }),
      },
    ]);
    expect(state.readCounts.get("a.ts")).toBe(1);
    expect(state.totalToolCalls).toBe(1);
  });

  test("run_shell file reads count as read evidence (CL-6937)", () => {
    const shell = (command: string): ThrashToolCallBlock => ({
      type: "tool_call",
      name: "run_shell",
      arguments: { command },
    });
    const readOnly = applyAll([shell("head -n 40 src/a.ts")]);
    expect(readOnly.readCounts.get("src/a.ts")).toBe(1);
    expect(readOnly.editedPaths.size).toBe(0);

    const neutral = applyAll([shell("bun run check")]);
    expect(neutral.readCounts.size).toBe(0);
    expect(neutral.editedPaths.size).toBe(0);
    expect(neutral.totalToolCalls).toBe(1);
  });

  test("chunked reads key by offset, whole-file reads key by path", () => {
    const state = applyAll([
      read("big.ts", { offset: 0, limit: 500 }),
      read("big.ts", { offset: 500, limit: 500 }),
      read("big.ts"),
    ]);
    expect(state.readCounts.get("big.ts")).toBe(1);
    expect(state.readCounts.get("big.ts::0:500")).toBe(1);
    expect(state.readCounts.get("big.ts::500:500")).toBe(1);
  });

  test("greps count toward read evidence keyed by pattern and path", () => {
    const state = applyAll([grep("needle"), grep("needle")]);
    expect(state.readCounts.get("grep::needle::src")).toBe(2);
  });

  test("config overrides apply to evaluateThrashStop", () => {
    expect(
      evaluateThrashStop({
        hasToolCalls: true,
        turnsCompleted: 5,
        maxTurns: 10,
        config: { forceReportWithin: 5 },
      }),
    ).toBe("report-forced");
  });
});
