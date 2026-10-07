import { test, expect, describe } from "bun:test";
import { viewToLines } from "./lines.js";
import type { ViewNode } from "./spec.js";

const textLines = (node: ViewNode, columns = 80): string[] =>
  viewToLines(node, columns).map((line) => line.map((s) => s.text).join(""));

describe("View rendering", () => {
  test("every line is exactly one visual row that fits the width", () => {
    const node: ViewNode = {
      type: "stack",
      children: [
        { type: "text", text: "Projects", bold: true },
        {
          type: "grid",
          rows: [
            [{ type: "text", text: "N", bold: true }],
            [{ type: "text", text: "a" }],
            [{ type: "text", text: "b" }],
            [{ type: "text", text: "c" }],
          ],
        },
        { type: "divider" },
        {
          type: "row",
          gap: 1,
          children: [
            { type: "text", text: "total", tone: "muted" },
            { type: "text", text: "3" },
          ],
        },
      ],
    };
    const columns = 80;
    // The viewport cuts by line; each produced line must paint as one row
    // no wider than the budget, or it overflows.
    for (const line of textLines(node, columns))
      expect(line.length).toBeLessThanOrEqual(columns - 2);
  });
});

describe("view line count", () => {
  const at = (node: ViewNode, cols = 80) => viewToLines(node, cols).length;

  test("single-line nodes are one row", () => {
    expect(at({ type: "divider" })).toBe(1);
    expect(at({ type: "text", text: "x" })).toBe(1);
  });

  test("text wraps by width", () => {
    expect(at({ type: "text", text: "x".repeat(100) }, 80)).toBe(2); // ceil(100/78)
    expect(at({ type: "text", text: "short" }, 80)).toBe(1);
  });

  test("word wrapping is counted, not undercounted by ceil(len/width)", () => {
    // Five 11-char words at width ~18 cannot pack two-per-line, so they take 5
    // rows; a naive ceil(59/18)=4 would undercount (the dangerous direction).
    const value = "wordwordwo wordwordwo wordwordwo wordwordwo wordwordwo";
    expect(at({ type: "text", text: value }, 20)).toBe(5);
  });

  test("grid is rows (caller supplies header as first row) + footer past the cap", () => {
    const cols = [{}];
    // header row + 2 data rows
    expect(
      at({
        type: "grid",
        columns: cols,
        rows: [
          [{ type: "text", text: "N" }],
          [{ type: "text", text: "a" }],
          [{ type: "text", text: "b" }],
        ],
      }),
    ).toBe(3);
    const many = Array.from({ length: 250 }, (_, i) => [
      { type: "text" as const, text: String(i) },
    ]);
    // 200 visible + 1 "+more" footer line
    expect(at({ type: "grid", columns: cols, rows: many })).toBe(201);
  });

  test("stack sums children and adds gaps", () => {
    const node: ViewNode = {
      type: "stack",
      gap: 1,
      children: [
        { type: "text", text: "H", bold: true },
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    };
    expect(at(node)).toBe(5); // title + two items + gaps (gap adds a blank row before each child after the first)
  });

  test("row contributes one line", () => {
    const node: ViewNode = {
      type: "row",
      gap: 1,
      children: [
        { type: "text", text: "label", tone: "muted" },
        { type: "text", text: "value" },
      ],
    };
    expect(at(node)).toBe(1);
  });
});
