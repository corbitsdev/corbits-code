import { test, expect } from "bun:test";

import { createDoomLoopCorrectiveNote } from "./doom-loop-note.js";

const repeat = {
  calls: [{ id: "c1", name: "manage_tasks", arguments: { action: "update" } }],
  repeatCount: 2,
  threshold: 3,
};

test("the note names the repeated calls and the tools on the wire", () => {
  const note = createDoomLoopCorrectiveNote(() => ["read_file", "run_shell"])(
    repeat,
  );
  expect(note).toContain("manage_tasks");
  expect(note).toContain("read_file");
  expect(note).toContain("run_shell");
});

test("the note offers both escape hatches and the consequence", () => {
  const note = createDoomLoopCorrectiveNote(() => [])(repeat);
  expect(note).toContain("tool_search");
  expect(note).toMatch(/reply to the operator/i);
  expect(note).toMatch(/ends this run/i);
});

test("the note reads the wire list lazily per invocation", () => {
  let wire: string[] = ["read_file"];
  const builder = createDoomLoopCorrectiveNote(() => wire);
  wire = ["read_file", "newly_activated"];
  expect(builder(repeat)).toContain("newly_activated");
});
