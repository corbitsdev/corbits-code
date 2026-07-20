import { test, expect } from "bun:test";
import { chromeDividerLine, sumChromeZoneRows } from "../../../src/tui/chrome-zones.js";
import { CHROME_ROWS } from "../../../src/tui/hooks/use-layout-geometry.js";

// Per-zone budgets are checked against rendered component output in
// chrome-zone-budgets.test.tsx; this pin only guards the overall total.
test("sumChromeZoneRows totals the zone budgets", () => {
  expect(sumChromeZoneRows()).toBe(11);
});

test("CHROME_ROWS is derived from chrome zone budgets", () => {
  expect(CHROME_ROWS).toBe(sumChromeZoneRows());
});

test("chromeDividerLine spans the requested inner width", () => {
  expect(chromeDividerLine(40).length).toBe(40);
  expect(chromeDividerLine(2).length).toBe(8);
  expect(chromeDividerLine(40)).toMatch(/^─+$/);
});
