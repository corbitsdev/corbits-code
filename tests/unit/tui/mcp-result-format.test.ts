import { test, expect, describe } from "bun:test";
import { formatMcpResult } from "../../../src/tui/mcp-result-format.js";

describe("formatMcpResult", () => {
  test("summarizes a wrapped list by its key", () => {
    const raw = JSON.stringify({
      projects: [
        { name: "Alpha", status: { name: "Planned" } },
        { name: "Beta", status: { name: "Backlog" } },
      ],
    });
    const r = formatMcpResult(raw);
    expect(r.preview).toBe("2 projects");
    expect(r.full).toContain("1. Alpha — Planned");
    expect(r.full).toContain("2. Beta — Backlog");
  });

  test("summarizes a bare array", () => {
    const r = formatMcpResult(JSON.stringify([{ title: "A" }, { title: "B" }, { title: "C" }]));
    expect(r.preview).toBe("3 items");
    expect(r.full).toContain("1. A");
  });

  test("uses the singular noun for a single item", () => {
    expect(formatMcpResult(JSON.stringify({ projects: [{ name: "Solo" }] })).preview).toBe("1 project");
  });

  test("renders a single record's scalar fields", () => {
    const r = formatMcpResult(JSON.stringify({ name: "Alpha", priority: { name: "Medium" }, items: [1, 2] }));
    expect(r.full).toContain("name: Alpha");
    expect(r.full).toContain("priority: Medium");
    expect(r.full).toContain("items: [2 items]");
  });

  test("bounds a huge list instead of dumping it", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ name: `Item ${i}` }));
    const r = formatMcpResult(JSON.stringify({ results: items }));
    expect(r.preview).toBe("500 results");
    expect(r.full).toContain("and 470 more");
    expect(r.full.length).toBeLessThan(4200);
  });

  test("handles non-JSON content as bounded text", () => {
    const r = formatMcpResult("just some text\nover two lines");
    expect(r.preview).toBe("2 lines");
  });
});
