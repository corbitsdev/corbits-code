import { test, expect, describe } from "bun:test";
import { validateView } from "../../../src/tui/view/validate.js";
import { viewToLines } from "../../../src/tui/view/lines.js";
import type { ViewNode } from "../../../src/tui/view/spec.js";

describe("validateView", () => {
  test("accepts a well-formed nested spec using only primitives", () => {
    const r = validateView({
      type: "stack",
      children: [
        { type: "text", text: "Projects", bold: true },
        {
          type: "grid",
          columns: [{ align: "left" }],
          rows: [
            [{ type: "text", text: "Name", bold: true, tone: "muted" }],
            [{ type: "text", text: "Alpha" }],
          ],
        },
        {
          type: "stack",
          children: [
            {
              type: "row",
              gap: 1,
              children: [
                { type: "text", text: "Status", tone: "muted" },
                { type: "text", text: "Active", tone: "success" },
              ],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test("reports a node-path-scoped error for a missing field", () => {
    const r = validateView({ type: "stack", children: [{ type: "text" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("root.children[0].text: expected a string");
  });

  test("rejects an unknown node type", () => {
    const r = validateView({ type: "chart" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown node type "chart"');
  });

  test("rejects an invalid tone", () => {
    const r = validateView({ type: "text", text: "x", tone: "neon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid tone");
  });

  test("rejects excessive nesting depth", () => {
    let node: unknown = { type: "text", text: "deep" };
    for (let i = 0; i < 12; i++) node = { type: "stack", children: [node] };
    const r = validateView(node);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max depth");
  });

  test("rejects a spec with too many nodes", () => {
    const children = Array.from({ length: 600 }, () => ({ type: "divider" }));
    const r = validateView({ type: "stack", children });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max of 500 nodes");
  });

  test("rejects a grid whose rows are not an array", () => {
    const r = validateView({ type: "grid", columns: [{}], rows: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("root.rows: expected an array");
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
    expect(at(node)).toBe(5); // title + two items + two inter-item gaps (gap adds a blank row before each child after the first)
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
