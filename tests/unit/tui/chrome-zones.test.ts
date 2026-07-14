import { test, expect } from "bun:test";
import { CHROME_ZONE_ROWS, chromeDividerLine, sumChromeZoneRows } from "../../../src/tui/chrome-zones.js";
import { CHROME_ROWS } from "../../../src/tui/hooks/use-layout-geometry.js";

test("sumChromeZoneRows matches documented zone budgets", () => {
  expect(sumChromeZoneRows()).toBe(
    CHROME_ZONE_ROWS.header
    + CHROME_ZONE_ROWS.progressDivider
    + CHROME_ZONE_ROWS.progress
    + CHROME_ZONE_ROWS.modelBar
    + CHROME_ZONE_ROWS.prompt
    + CHROME_ZONE_ROWS.status,
  );
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
