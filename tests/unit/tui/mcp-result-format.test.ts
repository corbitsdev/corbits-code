import { test, expect, describe } from "bun:test";
import { formatMcpResult, extractMcpRecords, extractMcpRecord } from "../../../src/tui/mcp-result-format.js";

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

// The detection primitives decide which renderer fires (table vs card
// vs text). Getting them wrong renders a list as a card or dumps raw JSON.
describe("extractMcpRecords (list detection)", () => {
  test("a bare array of objects is detected as records", () => {
    const r = extractMcpRecords(JSON.stringify([{ name: "a" }, { name: "b" }]));
    expect(r?.label).toBe("items");
    expect(r?.items).toHaveLength(2);
  });

  test("a wrapper with a single array key alongside scalars uses that key as the label", () => {
    const r = extractMcpRecords(JSON.stringify({ projects: [{ name: "a" }], hasNextPage: false }));
    expect(r?.label).toBe("projects");
    expect(r?.items).toHaveLength(1);
  });

  test("an empty array is not a record list (falls back to text)", () => {
    expect(extractMcpRecords("[]")).toBeNull();
  });

  test("an object with two array keys is ambiguous and not a list", () => {
    expect(extractMcpRecords(JSON.stringify({ a: [{ x: 1 }], b: [{ y: 2 }] }))).toBeNull();
  });

  test("a wrapper with a non-scalar sibling is treated as a record, not a list", () => {
    expect(extractMcpRecords(JSON.stringify({ projects: [{ name: "a" }], meta: { page: 1 } }))).toBeNull();
  });

  test("non-JSON content is not a record list", () => {
    expect(extractMcpRecords("hello world")).toBeNull();
  });
});

describe("extractMcpRecord (single record detection)", () => {
  test("a single object is a record", () => {
    const rec = extractMcpRecord(JSON.stringify({ name: "Proj", status: "active" }));
    expect(rec?.name).toBe("Proj");
  });

  test("a record list is not a single record", () => {
    expect(extractMcpRecord(JSON.stringify([{ name: "a" }, { name: "b" }]))).toBeNull();
  });

  test("a bare scalar or array is not a single record", () => {
    expect(extractMcpRecord("42")).toBeNull();
    expect(extractMcpRecord("[]")).toBeNull();
  });
});
