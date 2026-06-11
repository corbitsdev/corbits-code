import { test, expect, describe } from "bun:test";
import { render } from "ink-testing-library";
import { McpTable, mcpTableRowCount } from "../../../src/tui/components/mcp-table.js";
import { extractMcpRecords } from "../../../src/tui/mcp-result-format.js";

const projects = JSON.stringify({
  projects: [
    { name: "Data and insights home screen", status: { name: "Backlog" }, priority: { name: "None" }, team: { name: "Corbits" } },
    { name: "Interchange Dispatch", status: { name: "In Progress" }, priority: { name: "High" }, team: { name: "Interchange" } },
  ],
});

describe("extractMcpRecords", () => {
  test("pulls a wrapped record array", () => {
    const r = extractMcpRecords(projects);
    expect(r?.label).toBe("projects");
    expect(r?.items).toHaveLength(2);
  });
  test("returns null for a single record or scalar", () => {
    expect(extractMcpRecords(JSON.stringify({ name: "solo", id: 1 }))).toBeNull();
    expect(extractMcpRecords("not json")).toBeNull();
  });
});

describe("mcpTableRowCount", () => {
  test("counts header + rows, adds a footer when truncated", () => {
    expect(mcpTableRowCount(2, false)).toBe(3); // header + 2 rows
    expect(mcpTableRowCount(50, false)).toBe(10); // header + 8 + footer
    expect(mcpTableRowCount(50, true)).toBe(42); // header + 40 + footer
  });
});

describe("McpTable rendering", () => {
  test("renders headers and values, fits the width without wrapping", () => {
    const records = extractMcpRecords(projects)!;
    const width = 80;
    const { lastFrame } = render(<McpTable records={records} width={width} expanded={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Name");
    expect(frame).toContain("Status");
    expect(frame).toContain("Interchange Dispatch");
    expect(frame).toContain("In Progress");
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("shows a '+N more' footer when collapsed beyond the row cap", () => {
    const many = JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => ({ name: `Item ${i}` })) });
    const records = extractMcpRecords(many)!;
    const { lastFrame } = render(<McpTable records={records} width={80} expanded={false} />);
    expect(lastFrame()).toContain("more items");
  });
});
