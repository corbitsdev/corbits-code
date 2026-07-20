import { describe, expect, test } from "bun:test";
import { diffLines, diffStat, editDiffFromArgs, renderDiff } from "./diff.js";
import { color } from "./theme.js";

describe("renderDiff colors", () => {
  test("line-number column always uses the dim context token", () => {
    const lines = renderDiff("a\nb", "a\nB", 40);
    const numColColors = lines.map((line) => line[0]!.color);
    expect(numColColors).toEqual([color("diffContext"), color("diffContext"), color("diffContext")]);
  });

  test("sign column resolves from the diff token family", () => {
    const lines = renderDiff("a\nb", "a\nB", 40);
    const signColors = lines.map((line) => line[1]!.color);
    expect(signColors).toEqual([color("diffContext"), color("diffRemoved"), color("diffAdded")]);
  });

  test("context rows carry no dim attribute — the token owns the full appearance", () => {
    const lines = renderDiff("a\nb", "a\nB", 40);
    for (const line of lines) {
      for (const segment of line) expect(segment).not.toHaveProperty("dim");
    }
  });
});

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

  test("word-level LCS keeps shared tokens as context and paints only the delta", () => {
    const lines = renderDiff(
      "const foo = bar(x, y);",
      "const foo = baz(x, y);",
      80,
    );
    const delBody = lines[0]!.slice(2);
    const addBody = lines[1]!.slice(2);
    // Shared prefix tokens should not carry the add/remove colors.
    const delChanged = delBody.filter((s) => s.color === color("diffRemoved")).map((s) => s.text).join("");
    const addChanged = addBody.filter((s) => s.color === color("diffAdded")).map((s) => s.text).join("");
    expect(delChanged).toContain("bar");
    expect(addChanged).toContain("baz");
    expect(delChanged).not.toContain("const");
    expect(addChanged).not.toContain("const");
    // Shared tokens keep the context color.
    expect(delBody.some((s) => s.text.includes("const") && s.color === color("diffContext"))).toBe(true);
  });

  test("word-level LCS is not positional — reordered shared words stay context", () => {
    // Positional compare would mark every token changed; LCS keeps "a" and "c".
    const lines = renderDiff("a b c", "a x c", 40);
    const delBody = lines[0]!.slice(2);
    const changed = delBody.filter((s) => s.color === color("diffRemoved")).map((s) => s.text.trim()).filter(Boolean);
    expect(changed).toEqual(["b"]);
  });
});

describe("renderDiff line numbers", () => {
  test("context rows carry both old and new line numbers", () => {
    const lines = renderDiff("a\nb\nc", "a\nB\nc", 40);
    const text = (line: (typeof lines)[number]): string => line.map((seg) => seg.text).join("");
    expect(text(lines[0]!)).toContain("1 1");
    expect(text(lines[1]!)).toContain("2  ");
    expect(text(lines[2]!)).toContain(" 2");
    expect(text(lines[3]!)).toContain("3 3");
  });

  test("del rows show only the old number, add rows show only the new number", () => {
    const lines = renderDiff("old", "new", 40);
    const delText = lines[0]!.map((seg) => seg.text).join("");
    const addText = lines[1]!.map((seg) => seg.text).join("");
    expect(delText.trimStart().startsWith("1")).toBe(true);
    expect(addText.trimStart().startsWith("1")).toBe(true);
  });

  test("line numbers stay right-aligned as the file grows past one digit", () => {
    const oldText = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const newText = oldText.replace("line 0", "CHANGED");
    const lines = renderDiff(oldText, newText, 80);
    const widths = new Set(lines.map((line) => line[0]!.text.length));
    // Every row's number column pads to the same width regardless of digit count.
    expect(widths.size).toBe(1);
  });

  test("collapsed context marker carries no line number", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const newText = oldText.replace("line 0", "CHANGED");
    const lines = renderDiff(oldText, newText, 40, { contextLines: 2 });
    const marker = lines.find((line) => line.map((seg) => seg.text).join("").includes("unchanged line"));
    expect(marker).toBeDefined();
    expect(marker![0]!.text.trim()).toBe("");
  });
});
