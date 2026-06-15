import { test, expect, describe } from "bun:test";
import { extractMcpRecords, extractMcpRecord } from "../../../src/tui/mcp-result-format.js";
import { mcpRecordsToView, mcpRecordToView } from "../../../src/tui/mcp-view.js";
import { viewToLines } from "../../../src/tui/view/index.js";
import type { ViewNode } from "../../../src/tui/view/spec.js";

const frameOf = (node: ViewNode, columns: number): string =>
  viewToLines(node, columns)
    .map((line) => line.map((s) => s.text).join(""))
    .join("\n");

const projects = JSON.stringify({
  projects: [
    { name: "Website redesign", status: { name: "Backlog" }, priority: { name: "None" }, team: { name: "Acme" } },
    { name: "Mobile app launch", status: { name: "In Progress" }, priority: { name: "High" }, team: { name: "Globex" } },
  ],
});

describe("extractMcpRecords / extractMcpRecord", () => {
  test("pulls a wrapped record array", () => {
    const r = extractMcpRecords(projects);
    expect(r?.label).toBe("projects");
    expect(r?.items).toHaveLength(2);
  });
  test("distinguishes a single record from a list", () => {
    expect(extractMcpRecords(JSON.stringify({ name: "solo", id: 1 }))).toBeNull();
    expect(extractMcpRecord(JSON.stringify({ name: "solo", id: 1 }))).not.toBeNull();
    expect(extractMcpRecord(projects)).toBeNull();
  });
});

describe("mcpRecordsToView", () => {
  test("builds a table node with index + present columns and projected rows", () => {
    const node = mcpRecordsToView(extractMcpRecords(projects)!);
    expect(node.type).toBe("table");
    if (node.type !== "table") return;
    expect(node.columns.map((c) => c.header)).toEqual(["#", "Name", "Status", "Priority", "Team"]);
    expect(node.columns.find((c) => c.field === "status")?.colorRole).toBe("status");
    expect(node.rows[1]).toMatchObject({ name: "Mobile app launch", status: "In Progress", priority: "High", team: "Globex" });
  });

  test("renders through View, fitting the width", () => {
    const node = mcpRecordsToView(extractMcpRecords(projects)!);
    const frame = frameOf(node, 70);
    expect(frame).toContain("Mobile app launch");
    expect(frame).toContain("In Progress");
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(70);
  });
});

describe("mcpRecordToView", () => {
  const project = JSON.stringify({
    name: "Mobile app launch",
    status: { name: "In Progress" },
    priority: { name: "High" },
    id: "abc-123",
    createdAt: "2026-06-08T20:00:00.000Z",
    targetDate: "2026-06-17T00:00:00.000Z",
  });

  test("builds a card with title and salient fields, hiding ids and timestamps", () => {
    const node = mcpRecordToView(extractMcpRecord(project)!);
    expect(node.type).toBe("card");
    if (node.type !== "card") return;
    expect(node.title).toBe("Mobile app launch");
    const labels = node.fields.map((f) => f.label);
    expect(labels).toContain("Status");
    expect(labels).toContain("Target Date");
    expect(labels).not.toContain("Id");
    expect(labels).not.toContain("Created At");
    expect(node.fields.find((f) => f.label === "Status")?.tone).toBe("accent");
  });

  test("renders through View with the title and date", () => {
    const node = mcpRecordToView(extractMcpRecord(project)!);
    const frame = frameOf(node, 80);
    expect(frame).toContain("Mobile app launch");
    expect(frame).toContain("2026-06-17");
    expect(frame).not.toContain("abc-123");
  });
});
