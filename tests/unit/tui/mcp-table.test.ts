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
  test("builds a grid node with index + present columns and projected rows", () => {
    const node = mcpRecordsToView(extractMcpRecords(projects)!);
    expect(node.type).toBe("grid");
    if (node.type !== "grid") return;
    // header row is first; inspect its text nodes
    const headers = (node.rows[0] as any[]).map((c: any) => c.text);
    expect(headers).toEqual(["#", "Name", "Status", "Priority", "Team"]);
    // data row 1 (index 1 in rows) is the second record
    const row1 = node.rows[2] as any[];
    expect(row1[1]?.text).toBe("Mobile app launch");
    expect(row1[2]?.text).toBe("In Progress");
    expect(row1[3]?.text).toBe("High");
    expect(row1[4]?.text).toBe("Globex");
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

  test("builds a stack with title and salient rows for fields, hiding ids and timestamps", () => {
    const node = mcpRecordToView(extractMcpRecord(project)!);
    expect(node.type).toBe("stack");
    if (node.type !== "stack") return;
    const texts = (node.children as any[]).map((c: any) => c.text ?? (c.children?.[0]?.text + " " + c.children?.[1]?.text));
    expect(texts.some((t: string) => /Mobile app launch/.test(t))).toBe(true);
    expect(texts.some((t: string) => /Status/.test(t))).toBe(true);
    expect(texts.some((t: string) => /Target Date/.test(t))).toBe(true);
    expect(texts.join(" ")).not.toContain("abc-123");
    expect(texts.join(" ")).not.toContain("Created At");
  });

  test("renders through View with the title and date", () => {
    const node = mcpRecordToView(extractMcpRecord(project)!);
    const frame = frameOf(node, 80);
    expect(frame).toContain("Mobile app launch");
    expect(frame).toContain("2026-06-17");
    expect(frame).not.toContain("abc-123");
  });
});
