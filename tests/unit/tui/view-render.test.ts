import { test, expect, describe } from "bun:test";
import { viewToLines } from "../../../src/tui/view/index.js";
import type { ViewNode } from "../../../src/tui/view/spec.js";

const textLines = (node: ViewNode, columns = 80): string[] =>
  viewToLines(node, columns).map((line) => line.map((s) => s.text).join(""));

const frameOf = (node: ViewNode, columns = 80): string => textLines(node, columns).join("\n");

describe("View rendering", () => {
  test("renders a grid (table equivalent) with headers and colored cells, fitting width", () => {
    const node: ViewNode = {
      type: "grid",
      columns: [{}, { align: "left" }],
      rows: [
        [
          { type: "text", text: "Name", bold: true, tone: "muted" },
          { type: "text", text: "Status", bold: true, tone: "muted" },
        ],
        [
          { type: "text", text: "Alpha" },
          { type: "text", text: "Active", tone: "success" },
        ],
        [
          { type: "text", text: "Beta" },
          { type: "text", text: "Blocked", tone: "danger" },
        ],
      ],
    };
    const frame = frameOf(node, 60);
    expect(frame).toContain("Name");
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Blocked");
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(60);
  });

  test("renders a stack as card-like with title and rows for fields", () => {
    const node: ViewNode = {
      type: "stack",
      children: [
        { type: "text", text: "Mobile launch", bold: true, tone: "accent" },
        {
          type: "row",
          gap: 1,
          children: [
            { type: "text", text: "Status", tone: "muted" },
            { type: "text", text: "In Progress", tone: "accent" },
          ],
        },
        { type: "text", text: "[High]", tone: "warning" },
      ],
    };
    const frame = frameOf(node);
    expect(frame).toContain("Mobile launch");
    expect(frame).toContain("In Progress");
    expect(frame).toContain("[High]");
  });

  test("renders a stack of bold text + bullet list equivalent", () => {
    const node: ViewNode = {
      type: "stack",
      children: [
        { type: "text", text: "Items", bold: true },
        { type: "text", text: "• one" },
        { type: "text", text: "• two" },
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
    // The viewport cuts by line, so each produced line must paint as a single
    // row no wider than the budget — otherwise it would overflow.
    for (const line of textLines(node, columns)) expect(line.length).toBeLessThanOrEqual(columns - 2);
  });
});
