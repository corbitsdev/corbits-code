import { test, expect } from "bun:test";
import {
  chromeDividerLine,
  progressChromeRowCount,
  shouldShowProgressRow,
  sumChromeZoneRows,
} from "../../../src/tui/chrome-zones.js";
import { CHROME_ROWS } from "../../../src/tui/hooks/use-layout-geometry.js";

// Per-zone budgets are checked against rendered component output in
// chrome-zone-budgets.test.tsx; this pin only guards the overall total.
// Progress is optional (via progressChromeRowCount) so idle sessions stay quiet.
test("sumChromeZoneRows totals always-present zone budgets", () => {
  // header(2) + divider(1) + modelBar(1) + prompt(3) + status(2) = 9
  expect(sumChromeZoneRows()).toBe(9);
});

test("CHROME_ROWS is derived from chrome zone budgets", () => {
  expect(CHROME_ROWS).toBe(sumChromeZoneRows());
});

test("shouldShowProgressRow and progressChromeRowCount share one predicate", () => {
  const cases = [
    { active: false, hasWorkflow: false },
    { active: true, hasWorkflow: false },
    { active: false, hasWorkflow: true },
    { active: true, hasWorkflow: true },
  ] as const;
  for (const input of cases) {
    const show = shouldShowProgressRow(input);
    expect(progressChromeRowCount(input)).toBe(show ? 2 : 0);
  }
});

test("chromeDividerLine spans the requested inner width", () => {
  expect(chromeDividerLine(40).length).toBe(40);
  expect(chromeDividerLine(2).length).toBe(8);
  expect(chromeDividerLine(40)).toMatch(/^─+$/);
});
