import { test, expect } from "bun:test";
import { computeVisibleRows } from "../../../src/tui/hooks/use-layout-geometry.js";

test("computeVisibleRows: no extra chrome", () => {
  // 40 rows - 12 chrome - 0 overlay - 0 extra = 28
  expect(computeVisibleRows({ rows: 40, chromeRows: 12, effectiveOverlayRows: 0, extraChromeRows: 0 })).toBe(28);
});

test("computeVisibleRows: overlay subtracts from visible", () => {
  // 40 rows - 12 chrome - 10 overlay - 0 extra = 18
  expect(computeVisibleRows({ rows: 40, chromeRows: 12, effectiveOverlayRows: 10, extraChromeRows: 0 })).toBe(18);
});

test("computeVisibleRows: mcpAuthPrompt visible adds 2 extra rows", () => {
  // The McpAuthPrompt renders 2 rows outside overlay accounting
  expect(computeVisibleRows({ rows: 40, chromeRows: 12, effectiveOverlayRows: 0, extraChromeRows: 2 })).toBe(26);
});

test("computeVisibleRows: commandMessage visible adds 1 extra row", () => {
  // commandMessage renders 1 row outside overlay accounting
  expect(computeVisibleRows({ rows: 40, chromeRows: 12, effectiveOverlayRows: 0, extraChromeRows: 1 })).toBe(27);
});

test("computeVisibleRows: both mcpAuth and commandMessage visible", () => {
  expect(computeVisibleRows({ rows: 40, chromeRows: 12, effectiveOverlayRows: 0, extraChromeRows: 3 })).toBe(25);
});

test("computeVisibleRows: clamps to minimum of 1", () => {
  expect(computeVisibleRows({ rows: 10, chromeRows: 12, effectiveOverlayRows: 20, extraChromeRows: 5 })).toBe(1);
});
