import { describe, it, expect } from "bun:test";
import { allocate } from "./registry.js";
import type { ViewColumn } from "./spec.js";

describe("allocate", () => {
  it("should not absorb leftover width into a right-aligned first column", () => {
    // Simulate MCP records table: column 0 is "#" with align: "right"
    const columns: ViewColumn[] = [
      { header: "#", field: "__index", align: "right" },
      { header: "Name", field: "name", align: "left" },
    ];

    const rows = [
      { __index: "1", name: "First Item" },
      { __index: "2", name: "Second Item" },
      { __index: "3", name: "Third Item" },
    ];

    // Available width is 80 characters
    const available = 80;
    const result = allocate(columns, rows, available);

    // Column 0 ("#") should stay at its natural width (1 char for single digit)
    // not absorb all the leftover space
    // Natural widths: "#" = 1 char, "Name" = 11 chars ("Second Item")
    // Total with gap: 1 + 2 + 11 = 14 chars, so leftover is 80 - 14 = 66
    // Bug: leftover gets added to column 0, making it 67, which pushes the table right
    // Fix: leftover should NOT be added to column 0 if it's right-aligned
    // Instead, it should be added to the last column or the first left-aligned column

    expect(result.columns).toHaveLength(2);
    expect(result.widths).toHaveLength(2);

    // Column 0 should be small (just wide enough for its content)
    const col0Natural = 1; // "#" is 1 character wide
    expect(result.widths[0]).toBeLessThanOrEqual(col0Natural + 2); // Allow slight margin

    // Column 1 (Name) should absorb the leftover space instead
    // It should be significantly wider than its natural width
    const col1Natural = 11; // "Second Item"
    expect(result.widths[1]! > col1Natural).toBe(true);

    // The table should fit within the available width
    const GAP = 2;
    const totalWidth = result.widths.reduce((sum, w) => sum + w, 0) + GAP * (result.columns.length - 1);
    expect(totalWidth).toBeLessThanOrEqual(available);
  });

  it("should handle single column correctly", () => {
    const columns: ViewColumn[] = [{ header: "Value", field: "value", align: "left" }];
    const rows = [{ value: "test" }];
    const available = 80;

    const result = allocate(columns, rows, available);

    expect(result.columns).toHaveLength(1);
    expect(result.widths[0]).toBe(80); // Should absorb all available width
  });

  it("should drop columns when space is tight", () => {
    const columns: ViewColumn[] = [
      { header: "#", field: "__index", align: "right" },
      { header: "Name", field: "name" },
      { header: "Status", field: "status" },
      { header: "Priority", field: "priority" },
    ];
    const rows = [
      { __index: "1", name: "Item", status: "Done", priority: "High" },
    ];
    const available = 20; // Very tight

    const result = allocate(columns, rows, available);

    // Should drop rightmost columns and keep at least "#" and "Name"
    expect(result.columns.length).toBeGreaterThan(1);
    expect(result.columns.length).toBeLessThan(4);
  });
});
