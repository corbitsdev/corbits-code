import { describe, test, expect } from "bun:test";
import { locatePromptCursor, promptVisualLines } from "./prompt-layout.js";

describe("promptVisualLines", () => {
  test("logicalStart accounts for the space each soft break consumes", () => {
    // Width 10: "alpha beta gamma" wraps to "alpha" / "beta gamma"? Actually
    // greedy fill: "alpha beta" (10 cols) then "gamma". The soft break consumes
    // the space at index 10, so the second row starts at index 11 — not 10.
    const lines = promptVisualLines("alpha beta gamma", 10);
    expect(lines.map((l) => l.text)).toEqual(["alpha beta", "gamma"]);
    expect(lines[1]?.logicalStart).toBe(11);
  });

  test("drift does not compound across many soft wraps", () => {
    const value = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const lines = promptVisualLines(value, 12);
    for (const line of lines) {
      expect(value.slice(line.logicalStart, line.logicalStart + line.text.length)).toBe(line.text);
    }
  });

  test("empty logical lines still produce a row", () => {
    const lines = promptVisualLines("a\n\nb", 10);
    expect(lines.map((l) => l.text)).toEqual(["a", "", "b"]);
    expect(lines[2]?.logicalStart).toBe(3);
  });
});

describe("locatePromptCursor", () => {
  test("maps a cursor after a soft wrap onto the correct row and column", () => {
    const value = "alpha beta gamma";
    const lines = promptVisualLines(value, 10);
    // Cursor on the "g" of gamma (index 11) — first column of the second row.
    const at = locatePromptCursor(lines, 11);
    expect(at.cursorLine).toBe(1);
    expect(at.cursorCol).toBe(0);
  });

  test("does not split a surrogate pair at the cursor", () => {
    const value = "hi 😀 there";
    const lines = promptVisualLines(value, 40);
    const at = locatePromptCursor(lines, value.indexOf("😀"));
    const line = lines[at.cursorLine]!.text;
    expect(line.slice(at.cursorCol, at.cursorCol + at.cursorCharLength)).toBe("😀");
  });
});
