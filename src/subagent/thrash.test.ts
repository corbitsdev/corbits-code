import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THRASH_CONFIG,
  EMPTY_THRASH_STATE,
  evaluateThrashStop,
  nextThrashState,
  thrashForceReport,
  thrashFromReRead,
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

function applyAll(calls: ReadonlyArray<ThrashToolCallBlock>): ThrashState {
  return nextThrashState(EMPTY_THRASH_STATE, calls);
}

describe("thrash pure module", () => {
  test("defaults are conservative (reReadLimit 4, forceReportWithin 2)", () => {
    expect(DEFAULT_THRASH_CONFIG.reReadLimit).toBe(4);
    expect(DEFAULT_THRASH_CONFIG.forceReportWithin).toBe(2);
    expect(DEFAULT_THRASH_CONFIG.reReadMinTotalTools).toBeGreaterThanOrEqual(
      DEFAULT_THRASH_CONFIG.reReadLimit,
    );
  });

  test("re-read after edit of the same path trips thrash once total tool volume clears the gate", () => {
    const path = "src/subagent/index.ts";
    // One edit + reReadLimit reads of the same path, padded with enough other
    // tool calls to clear reReadMinTotalTools (the edited-path branch is
    // gated on total tool volume just like the non-edited branch).
    const calls: ThrashToolCallBlock[] = [edit(path)];
    for (let i = 0; i < DEFAULT_THRASH_CONFIG.reReadLimit; i++) {
      calls.push(read(path));
    }
    for (let i = calls.length; i < DEFAULT_THRASH_CONFIG.reReadMinTotalTools; i++) {
      calls.push(grep(`p${i}`));
    }
    const state = applyAll(calls);
    expect(state.totalToolCalls).toBeGreaterThanOrEqual(DEFAULT_THRASH_CONFIG.reReadMinTotalTools);
    expect(thrashFromReRead(state)).toBe(true);
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 3,
        maxTurns: 25,
      }),
    ).toBe("thrash");
  });

  test("re-read after edit stays under thrash while total tool volume is low", () => {
    const path = "src/subagent/index.ts";
    const calls: ThrashToolCallBlock[] = [edit(path)];
    for (let i = 0; i < DEFAULT_THRASH_CONFIG.reReadLimit; i++) {
      calls.push(read(path));
    }
    const state = applyAll(calls);
    expect(state.totalToolCalls).toBeLessThan(DEFAULT_THRASH_CONFIG.reReadMinTotalTools);
    expect(thrashFromReRead(state)).toBe(false);
  });

  test("write_file and delete_file also mark paths as edited for re-read thrash", () => {
    const written = applyAll([
      write("a.ts"),
      read("a.ts"),
      read("a.ts"),
      read("a.ts"),
      read("a.ts"),
      grep("p1"),
      grep("p2"),
      grep("p3"),
    ]);
    expect(thrashFromReRead(written)).toBe(true);

    const deleted = applyAll([
      del("b.ts"),
      read("b.ts"),
      read("b.ts"),
      read("b.ts"),
      read("b.ts"),
      grep("p1"),
      grep("p2"),
      grep("p3"),
    ]);
    expect(thrashFromReRead(deleted)).toBe(true);
  });

  test("multi-file unique reads do NOT thrash", () => {
    const calls: ThrashToolCallBlock[] = [];
    for (let i = 0; i < 20; i++) {
      calls.push(read(`src/file-${i}.ts`));
    }
    const state = applyAll(calls);
    expect(state.readCounts.size).toBe(20);
    expect(thrashFromReRead(state)).toBe(false);
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 5,
        maxTurns: 25,
      }),
    ).toBeNull();
  });

  test("few re-reads of one path without edit stay under thrash", () => {
    // 3 reads < reReadLimit=4, even with other tools mixed in.
    const state = applyAll([
      read("big.ts"),
      grep("x"),
      read("big.ts"),
      grep("y"),
      read("big.ts"),
    ]);
    expect(thrashFromReRead(state)).toBe(false);
  });

  test("re-reads without edit only thrash past reReadLimit and min total tools", () => {
    const under = applyAll([read("a.ts"), read("a.ts"), read("a.ts"), read("a.ts")]);
    // 4 reads of same path but totalToolCalls (4) < reReadMinTotalTools (8).
    expect(under.totalToolCalls).toBe(4);
    expect(thrashFromReRead(under)).toBe(false);

    const calls: ThrashToolCallBlock[] = [];
    for (let i = 0; i < 4; i++) calls.push(read("a.ts"));
    for (let i = 0; i < 4; i++) calls.push(grep(`p${i}`));
    const over = applyAll(calls);
    expect(over.totalToolCalls).toBe(8);
    expect(thrashFromReRead(over)).toBe(true);
  });

  test("near-budget force-report fires once, leaving turn-budget reachable", () => {
    const state = applyAll([read("a.ts")]);
    // maxTurns=10, forceReportWithin=2 → single nudge at turnsCompleted === 8.
    expect(thrashForceReport(7, 10, true)).toBe(false);
    expect(thrashForceReport(8, 10, true)).toBe(true);
    expect(thrashForceReport(9, 10, true)).toBe(false);
    expect(thrashForceReport(10, 10, true)).toBe(false);
    // No tools this turn → not force-report (tool-less is complete/never-acted).
    expect(thrashForceReport(8, 10, false)).toBe(false);

    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 8,
        maxTurns: 10,
      }),
    ).toBe("report-forced");
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 7,
        maxTurns: 10,
      }),
    ).toBeNull();
    // Turn-budget remains reachable after the single nudge turn.
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 9,
        maxTurns: 10,
      }),
    ).toBeNull();
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 10,
        maxTurns: 10,
      }),
    ).toBeNull(); // evaluateThrashStop only owns thrash / report-forced; turn-budget is the caller's job.
  });

  test("small maxTurns degrades gracefully instead of collapsing to a single turn", () => {
    // No room for a nudge turn: go straight to the caller's turn-budget check.
    expect(thrashForceReport(1, 1, true)).toBe(false);
    expect(thrashForceReport(1, 2, true)).toBe(false);
    expect(thrashForceReport(2, 2, true)).toBe(false);
    // maxTurns=3 has room for exactly one nudge turn before the cap.
    expect(thrashForceReport(1, 3, true)).toBe(true);
    expect(thrashForceReport(2, 3, true)).toBe(false);
    expect(thrashForceReport(3, 3, true)).toBe(false);
  });

  test("thrash is preferred over report-forced when both apply", () => {
    const path = "hot.ts";
    const state = applyAll([
      edit(path),
      read(path),
      read(path),
      read(path),
      read(path),
      grep("p1"),
      grep("p2"),
      grep("p3"),
    ]);
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 24,
        maxTurns: 25,
      }),
    ).toBe("thrash");
  });

  test("tool-less turns never return thrash stop reasons", () => {
    const state = applyAll([
      edit("a.ts"),
      read("a.ts"),
      read("a.ts"),
      read("a.ts"),
      read("a.ts"),
    ]);
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: false,
        turnsCompleted: 24,
        maxTurns: 25,
      }),
    ).toBeNull();
  });

  test("nextThrashState is pure and accumulates across turns, decaying reads on edit", () => {
    let state = EMPTY_THRASH_STATE;
    state = nextThrashState(state, [read("a.ts")]);
    // The edit decays the prior read count for a.ts back to zero — the file
    // changed, so the read before it no longer counts as re-read pressure.
    state = nextThrashState(state, [edit("a.ts")]);
    expect(state.readCounts.has("a.ts")).toBe(false);
    state = nextThrashState(state, [read("a.ts"), read("a.ts")]);
    state = nextThrashState(state, [read("a.ts")]);
    expect(state.readCounts.get("a.ts")).toBe(3);
    expect(state.editedPaths.has("a.ts")).toBe(true);
    expect(state.totalToolCalls).toBe(5);
    // Below reReadLimit (4) post-decay, and below the total-tool-volume gate.
    expect(thrashFromReRead(state)).toBe(false);

    state = nextThrashState(state, [read("a.ts")]);
    state = nextThrashState(state, [grep("p1"), grep("p2"), grep("p3")]);
    expect(state.readCounts.get("a.ts")).toBe(4);
    expect(state.totalToolCalls).toBe(9);
    expect(thrashFromReRead(state)).toBe(true);
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

  test("an ordinary edit-then-verify loop does not thrash", () => {
    // edit -> read-back verify, four times, on one file: legitimate iteration.
    // Each edit decays the prior read count for the path, so re-read pressure
    // never accumulates across cycles.
    let state = EMPTY_THRASH_STATE;
    for (let i = 0; i < 4; i++) {
      state = nextThrashState(state, [edit("hot.ts")]);
      state = nextThrashState(state, [read("hot.ts")]);
    }
    expect(thrashFromReRead(state)).toBe(false);
    expect(
      evaluateThrashStop({ state, hasToolCalls: true, turnsCompleted: 8, maxTurns: 30 }),
    ).toBeNull();
  });

  test("chunked reads of a large edited file key by offset, not just path", () => {
    let state = EMPTY_THRASH_STATE;
    state = nextThrashState(state, [edit("big.ts")]);
    state = nextThrashState(state, [
      read("big.ts", { offset: 0, limit: 500 }),
      read("big.ts", { offset: 500, limit: 500 }),
      read("big.ts", { offset: 1000, limit: 500 }),
      read("big.ts", { offset: 1500, limit: 500 }),
    ]);
    // Four distinct chunks, none repeated — not re-read pressure.
    expect(thrashFromReRead(state)).toBe(false);
    expect(
      evaluateThrashStop({ state, hasToolCalls: true, turnsCompleted: 2, maxTurns: 30 }),
    ).toBeNull();
  });

  test("re-reading the same chunk repeatedly still trips thrash", () => {
    let state = EMPTY_THRASH_STATE;
    state = nextThrashState(state, [edit("big.ts")]);
    for (let i = 0; i < DEFAULT_THRASH_CONFIG.reReadLimit; i++) {
      state = nextThrashState(state, [read("big.ts", { offset: 0, limit: 500 })]);
    }
    for (let i = 0; i < 3; i++) {
      state = nextThrashState(state, [grep(`p${i}`)]);
    }
    expect(thrashFromReRead(state)).toBe(true);
  });

  test("config overrides apply to evaluateThrashStop", () => {
    const state = applyAll([read("a.ts"), read("a.ts")]);
    expect(
      evaluateThrashStop({
        state,
        hasToolCalls: true,
        turnsCompleted: 1,
        maxTurns: 25,
        config: { reReadLimit: 2, reReadMinTotalTools: 1 },
      }),
    ).toBe("thrash");
  });
});
