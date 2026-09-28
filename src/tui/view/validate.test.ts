import { test, expect, describe } from "bun:test";
import { validateView } from "./validate.js";

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
