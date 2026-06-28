import { describe, expect, test } from "bun:test";
import { diffLines, diffStat, editDiffFromArgs, renderDiff } from "./diff.js";

describe("diffLines", () => {
  test("marks added, removed, and context lines", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(rows).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ]);
  });

  test("treats an empty old side as a pure addition", () => {
    const rows = diffLines("", "x\ny");
    expect(rows).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });
});

describe("diffStat", () => {
  test("counts additions and removals", () => {
    expect(diffStat("a\nb", "a\nc\nd")).toEqual({ added: 2, removed: 1 });
  });
});

describe("editDiffFromArgs", () => {
  test("reads edit_file before/after from old_string and new_string", () => {
    const result = editDiffFromArgs("edit_file", JSON.stringify({ path: "x.ts", old_string: "foo", new_string: "bar" }));
    expect(result).toEqual({ oldText: "foo", newText: "bar", path: "x.ts" });
  });

  test("treats write_file content as the new side against an empty old side", () => {
    const result = editDiffFromArgs("write_file", JSON.stringify({ path: "x.ts", content: "line" }));
    expect(result).toEqual({ oldText: "", newText: "line", path: "x.ts" });
  });

  test("returns null for unrelated tools and bad JSON", () => {
    expect(editDiffFromArgs("read_file", "{}")).toBeNull();
    expect(editDiffFromArgs("edit_file", "not json")).toBeNull();
  });
});

describe("renderDiff", () => {
  test("prefixes changed lines with + and - gutters", () => {
    const lines = renderDiff("old", "new", 40);
    const text = lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");
    expect(text).toContain("- old");
    expect(text).toContain("+ new");
  });

  test("collapses unchanged runs when contextLines is set", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const newText = oldText.replace("line 0", "CHANGED");
    const lines = renderDiff(oldText, newText, 40, { contextLines: 2 });
    const text = lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");
    expect(text).toContain("unchanged line");
  });
});
