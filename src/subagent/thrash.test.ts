import { describe, expect, test } from "bun:test";
import {
  EMPTY_THRASH_STATE,
  nextThrashState,
  salvagePathsFromThrash,
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

  test("nextThrashState is pure and accumulates across turns", () => {
    let state = EMPTY_THRASH_STATE;
    state = nextThrashState(state, [read("a.ts")]);
    // An edit no longer erases read evidence: readCounts is the requireEvidence
    // record, not a thrash counter.
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

  test("run_shell file reads count as read evidence", () => {
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

  test("salvagePathsFromThrash lists edited first, then read paths, capped", () => {
    const state = applyAll([
      read("src/read.ts"),
      edit("src/edit.ts"),
      read("src/read.ts", { offset: 0, limit: 20 }),
      grep("needle"),
    ]);
    expect(salvagePathsFromThrash(state)).toEqual(["src/edit.ts", "src/read.ts", "src"]);
    expect(salvagePathsFromThrash(state, 0)).toEqual([]);
    expect(salvagePathsFromThrash(EMPTY_THRASH_STATE)).toEqual([]);
  });
});
