import { test, expect, describe } from "bun:test";
import { render } from "ink-testing-library";
import { McpTable, mcpTableRowCount, McpRecordCard } from "../../../src/tui/components/mcp-table.js";
import { extractMcpRecords, extractMcpRecord } from "../../../src/tui/mcp-result-format.js";

const projects = JSON.stringify({
  projects: [
    { name: "Website redesign", status: { name: "Backlog" }, priority: { name: "None" }, team: { name: "Acme" } },
    { name: "Mobile app launch", status: { name: "In Progress" }, priority: { name: "High" }, team: { name: "Globex" } },
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
  test("counts header + every row, no footer under the sanity cap", () => {
    expect(mcpTableRowCount(2)).toBe(3); // header + 2 rows
    expect(mcpTableRowCount(50)).toBe(51); // header + 50 rows, no truncation
    expect(mcpTableRowCount(250)).toBe(202); // header + 200 + footer past the cap
  });
});

describe("McpTable rendering", () => {
  test("renders headers and values, fits the width without wrapping", () => {
    const records = extractMcpRecords(projects)!;
    const width = 80;
    const { lastFrame } = render(<McpTable records={records} width={width} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Name");
    expect(frame).toContain("Status");
    expect(frame).toContain("Mobile app launch");
    expect(frame).toContain("In Progress");
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("renders every row rather than truncating a moderate list", () => {
    const many = JSON.stringify({ items: Array.from({ length: 30 }, (_, i) => ({ name: `Item ${i}` })) });
    const records = extractMcpRecords(many)!;
    const frame = render(<McpTable records={records} width={80} />).lastFrame() ?? "";
    expect(frame).toContain("Item 29");
    expect(frame).not.toContain("more items");
  });
});

describe("McpRecordCard", () => {
  const project = JSON.stringify({
    name: "Mobile app launch",
    status: { name: "In Progress" },
    priority: { name: "High" },
    team: { name: "Acme" },
    id: "abc-123",
    createdAt: "2026-06-08T20:00:00.000Z",
    targetDate: "2026-06-17T00:00:00.000Z",
  });

  test("extractMcpRecord pulls a single object but not a list", () => {
    expect(extractMcpRecord(project)).not.toBeNull();
    expect(extractMcpRecord(JSON.stringify({ projects: [{ name: "a" }] }))).toBeNull();
  });

  test("renders the title and salient fields, hides noise", () => {
    const record = extractMcpRecord(project)!;
    const frame = render(<McpRecordCard record={record} width={80} />).lastFrame() ?? "";
    expect(frame).toContain("Mobile app launch");
    expect(frame).toContain("Status");
    expect(frame).toContain("In Progress");
    expect(frame).toContain("Target");
    expect(frame).toContain("2026-06-17");
    expect(frame).not.toContain("abc-123"); // id hidden
    expect(frame).not.toContain("Created"); // createdAt hidden
  });
});
