import { describe, expect, test } from "bun:test";
import { stringWidth, wrapLines, wrapRanges } from "./height.js";

describe("stringWidth", () => {
  test("counts wide glyphs as two columns and emoji correctly", () => {
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("你好")).toBe(4);
    expect(stringWidth("🚀")).toBe(2);
  });
});

describe("wrapRanges narrow path is unchanged", () => {
  test("breaks on the last space within the budget", () => {
    expect(wrapLines("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
  });

  test("hard-breaks a word longer than the budget", () => {
    expect(wrapLines("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("a line within the budget is one row", () => {
    expect(wrapRanges("short", 10)).toEqual([{ start: 0, end: 5 }]);
  });
});

describe("wrapRanges accounts for display width", () => {
  test("a row of wide glyphs wraps at the column budget, not the code-unit count", () => {
    // Four CJK glyphs are eight columns; a budget of four fits two per row.
    const rows = wrapLines("你好世界", 4);
    expect(rows).toEqual(["你好", "世界"]);
  });

  test("never splits a surrogate-pair emoji across rows", () => {
    const rows = wrapLines("🚀🚀🚀", 3);
    for (const row of rows) {
      // A split emoji would leave a lone surrogate; every row must round-trip.
      expect([...row].join("")).toBe(row);
      // Each emoji is width two, so a width-3 row holds exactly one.
      expect(stringWidth(row)).toBe(2);
    }
    expect(rows.join("")).toBe("🚀🚀🚀");
  });

  test("wide content still soft-breaks on spaces", () => {
    expect(wrapLines("你好 世界", 4)).toEqual(["你好", "世界"]);
  });
});
