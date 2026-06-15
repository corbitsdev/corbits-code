import { test, expect, describe } from "bun:test";
import { viewToLines } from "../../../src/tui/view/index.js";
import type { ViewNode } from "../../../src/tui/view/spec.js";

const textLines = (node: ViewNode, columns = 80): string[] =>
  viewToLines(node, columns).map((line) => line.map((s) => s.text).join(""));

const frameOf = (node: ViewNode, columns = 80): string => textLines(node, columns).join("\n");

describe("View rendering", () => {
  test("renders a table with headers, values, and colored-by-role cells, fitting width", () => {
    const node: ViewNode = {
      type: "table",
      columns: [
        { header: "Name", field: "name" },
        { header: "Status", field: "status", colorRole: "status" },
      ],
      rows: [
        { name: "Alpha", status: "Active" },
        { name: "Beta", status: "Blocked" },
      ],
    };
    const frame = frameOf(node, 60);
    expect(frame).toContain("Name");
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Blocked");
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  test("renders a card with title and fields", () => {
    const node: ViewNode = {
      type: "card",
      title: "Mobile launch",
      fields: [{ label: "Status", value: "In Progress", tone: "accent" }],
      badges: [{ label: "High", tone: "warning" }],
    };
    const frame = frameOf(node);
    expect(frame).toContain("Mobile launch");
    expect(frame).toContain("In Progress");
    expect(frame).toContain("[High]");
  });

  test("renders a stack of heading + list", () => {
    const node: ViewNode = {
      type: "stack",
      children: [
        { type: "heading", value: "Items" },
        { type: "list", items: ["one", "two"] },
      ],
    };
    const frame = frameOf(node);
    expect(frame).toContain("Items");
    expect(frame).toContain("• one");
    expect(frame).toContain("• two");
  });

  test("every line is exactly one visual row that fits the width", () => {
    const node: ViewNode = {
      type: "stack",
      children: [
        { type: "heading", value: "Projects" },
        { type: "table", columns: [{ header: "N", field: "n" }], rows: [{ n: "a" }, { n: "b" }, { n: "c" }] },
        { type: "divider" },
        { type: "keyValue", pairs: [{ label: "total", value: "3" }] },
      ],
    };
    const columns = 80;
    // The viewport cuts by line, so each produced line must paint as a single
    // row no wider than the budget — otherwise it would overflow.
    for (const line of textLines(node, columns)) expect(line.length).toBeLessThanOrEqual(columns - 2);
  });
});
