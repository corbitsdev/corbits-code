import { describe, it, expect } from "bun:test";
import { viewToLines } from "./lines.js";
import type { ViewNode } from "./spec.js";

function frame(node: ViewNode, cols = 80): string[] {
  return viewToLines(node, cols).map((ln) => ln.map((s) => s.text).join(""));
}

describe("grid width allocation (via view)", () => {
  it("renders a grid without exceeding available width and absorbs leftover into last column", () => {
    const node: ViewNode = {
      type: "grid",
      columns: [{ align: "right" }, { align: "left" }],
      rows: [
        [{ type: "text", text: "#" }, { type: "text", text: "Name" }],
        [{ type: "text", text: "1" }, { type: "text", text: "First Item" }],
        [{ type: "text", text: "2" }, { type: "text", text: "Second Item" }],
      ],
    };
    const lines = frame(node, 80);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80 - 2);
    // second data row should appear (absorption puts long content on last col)
    expect(lines.some((l) => /Second Item/.test(l))).toBe(true);
  });

  it("drops right columns when space is tight", () => {
    const node: ViewNode = {
      type: "grid",
      rows: [
        [
          { type: "text", text: "#" },
          { type: "text", text: "Name" },
          { type: "text", text: "Status" },
          { type: "text", text: "Priority" },
        ],
        [{ type: "text", text: "1" }, { type: "text", text: "Item" }, { type: "text", text: "Done" }, { type: "text", text: "High" }],
      ],
    };
    const lines = frame(node, 20);
    const first = lines[0] || "";
    // dropped the 4th column; trailing pad may create an empty split part, so test by content
    expect(first).not.toContain("Priority");
    expect(first.split(/\s{2,}/).filter(Boolean).length).toBeLessThan(4);
  });
});