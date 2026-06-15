import { test, expect, describe } from "bun:test";
import { validateView } from "../../../src/tui/view/validate.js";
import { viewToLines } from "../../../src/tui/view/lines.js";
import type { ViewNode } from "../../../src/tui/view/spec.js";

describe("validateView", () => {
  test("accepts a well-formed nested spec", () => {
    const r = validateView({
      type: "stack",
      children: [
        { type: "heading", value: "Projects", level: 2 },
        { type: "table", columns: [{ header: "Name", field: "name" }], rows: [{ name: "Alpha" }] },
        { type: "card", title: "Alpha", fields: [{ label: "Status", value: "Active", tone: "success" }] },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test("reports a node-path-scoped error for a missing field", () => {
    const r = validateView({ type: "stack", children: [{ type: "text" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("root.children[0].value: expected a string");
  });

  test("rejects an unknown node type", () => {
    const r = validateView({ type: "chart" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown node type "chart"');
  });

  test("rejects an invalid tone", () => {
    const r = validateView({ type: "badge", label: "x", tone: "neon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid tone");
  });

  test("rejects excessive nesting depth", () => {
    let node: unknown = { type: "text", value: "deep" };
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

  test("rejects a table whose rows are not an array", () => {
    const r = validateView({ type: "table", columns: [{ header: "N", field: "n" }], rows: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("root.rows: expected an array");
  });
});

describe("view line count", () => {
  const at = (node: ViewNode, cols = 80) => viewToLines(node, cols).length;

  test("single-line nodes are one row", () => {
    expect(at({ type: "divider" })).toBe(1);
    expect(at({ type: "badge", label: "x" })).toBe(1);
    expect(at({ type: "progress", value: 1 })).toBe(1);
  });

  test("text wraps by width", () => {
    expect(at({ type: "text", value: "x".repeat(100) }, 80)).toBe(2); // ceil(100/78)
    expect(at({ type: "text", value: "short" }, 80)).toBe(1);
  });

  test("word wrapping is counted, not undercounted by ceil(len/width)", () => {
    // Five 11-char words at width ~18 cannot pack two-per-line, so they take 5
    // rows; a naive ceil(59/18)=4 would undercount (the dangerous direction).
    const value = "wordwordwo wordwordwo wordwordwo wordwordwo wordwordwo";
    expect(at({ type: "text", value }, 20)).toBe(5);
  });

  test("keyValue and list are one row per item", () => {
    expect(at({ type: "keyValue", pairs: [{ label: "a", value: "1" }, { label: "b", value: "2" }] })).toBe(2);
    expect(at({ type: "list", items: ["a", "b", "c"] })).toBe(3);
  });

  test("table is header + rows, with a footer past the cap", () => {
    const cols = [{ header: "N", field: "n" }];
    expect(at({ type: "table", columns: cols, rows: [{ n: "a" }, { n: "b" }] })).toBe(3);
    const many = Array.from({ length: 250 }, (_, i) => ({ n: String(i) }));
    expect(at({ type: "table", columns: cols, rows: many })).toBe(202);
  });

  test("card counts title, subtitle, fields, and a badge row", () => {
    expect(
      at({ type: "card", title: "T", subtitle: "S", fields: [{ label: "a", value: "1" }], badges: [{ label: "x" }] }),
    ).toBe(4);
  });

  test("stack sums children and adds gaps", () => {
    const node: ViewNode = {
      type: "stack",
      gap: 1,
      children: [
        { type: "heading", value: "H" },
        { type: "list", items: ["a", "b"] },
      ],
    };
    expect(at(node)).toBe(1 + 2 + 1); // heading + list + one gap
  });
});
