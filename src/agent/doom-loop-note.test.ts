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

test("the note offers an on-wire switch before the tool_search fallback", () => {
  const note = createDoomLoopCorrectiveNote(() => [
    "manage_tasks",
    "read_file",
    "run_shell",
  ])(repeat);
  // First escape names a non-looped tool already on the wire...
  expect(note).toMatch(/already on the wire instead \(for example read_file\)/);
  // ...positioned ahead of the tool_search / reply-to-operator fallback.
  expect(note.indexOf("for example read_file")).toBeLessThan(
    note.indexOf("tool_search"),
  );
  expect(note).toMatch(/reply to the operator/i);
});

test("the note skips tool_search when another remaining tool is on the wire", () => {
  const note = createDoomLoopCorrectiveNote(() => [
    "manage_tasks",
    "tool_search",
    "read_file",
  ])(repeat);
  expect(note).toMatch(/already on the wire instead \(for example read_file\)/);
  expect(note).not.toMatch(/for example tool_search/);
});

test("the note uses the fallback when only tool_search remains", () => {
  const note = createDoomLoopCorrectiveNote(() => [
    "manage_tasks",
    "tool_search",
  ])(repeat);
  expect(note).not.toMatch(/for example tool_search/);
  expect(note).toContain("call tool_search to discover a different tool");
  expect(note).not.toMatch(/already on the wire instead/);
});

test("the note uses the fallback when every advertised name is looped", () => {
  const note = createDoomLoopCorrectiveNote(() => ["manage_tasks"])(repeat);
  expect(note).not.toMatch(/for example /);
  expect(note).not.toMatch(/already on the wire instead/);
  expect(note).toContain("call tool_search to discover a different tool");
});

test("the note reads the wire list lazily per invocation", () => {
  let wire: string[] = ["read_file"];
  const builder = createDoomLoopCorrectiveNote(() => wire);
  wire = ["read_file", "newly_activated"];
  expect(builder(repeat)).toContain("newly_activated");
});
