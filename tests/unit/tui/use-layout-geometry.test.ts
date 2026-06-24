import { test, expect } from "bun:test";
import { computeVisibleRows, wrappedLineCount, computeOverlayRows } from "../../../src/tui/hooks/use-layout-geometry.js";

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

test("computeVisibleRows: CHROME_ROWS=8 reserves room for header second line", () => {
  // 24 rows terminal - 8 chrome - 0 overlay - 0 extra = 16 visible rows
  expect(computeVisibleRows({ rows: 24, chromeRows: 8, effectiveOverlayRows: 0, extraChromeRows: 0 })).toBe(16);
});

test("wrappedLineCount: single line fits width", () => {
  expect(wrappedLineCount("hello world", 80)).toBe(1);
});

test("wrappedLineCount: line wraps to multiple", () => {
  expect(wrappedLineCount("a".repeat(100), 80)).toBe(2);
});

test("wrappedLineCount: explicit newlines count as separate lines", () => {
  expect(wrappedLineCount("line one\nline two\nline three", 80)).toBe(3);
});

test("wrappedLineCount: mixed wrapping and newlines", () => {
  const text = "first paragraph\n" + "a".repeat(120) + "\nlast paragraph";
  expect(wrappedLineCount(text, 80)).toBe(4);
});

test("wrappedLineCount: long word splits across lines", () => {
  expect(wrappedLineCount("a".repeat(200), 80)).toBe(3);
});

test("wrappedLineCount: exact-multiple long word does not overcount", () => {
  expect(wrappedLineCount("a".repeat(160), 80)).toBe(2);
});

test("wrappedLineCount: empty string returns 1", () => {
  expect(wrappedLineCount("", 80)).toBe(1);
});

test("wrappedLineCount: whitespace-only returns 1", () => {
  expect(wrappedLineCount("   \n  \n  ", 80)).toBe(3);
});

test("wrappedLineCount: respects the actual width limit", () => {
  expect(wrappedLineCount("hello world", 5)).toBe(2);
});

test("computeOverlayRows: multi-line permission subject returns exact expected rows", () => {
  const script = "cat << 'EOF'\n#!/usr/bin/env bash\necho 'hello world'\nEOF";
  const expectedSubjectLines = wrappedLineCount(`Run shell command: ${script}`, 60);
  const rows = computeOverlayRows({
    gateContext: {
      pendingPermission: {
        action: "Run shell command",
        subject: script,
        scopes: [{ pattern: null }],
      },
      pendingOperator: null,
    },
    modalContext: {
      helpOpen: false,
      hookPanelOpen: false,
      exitConfirmOpen: false,
      agentModalOpen: false,
      permissionsOpen: false,
      permissionEntryCount: 0,
    },
    hookCount: 0,
    providerCatalog: [],
    innerWidth: 60,
  });
  expect(rows).toBe(13 + expectedSubjectLines);
  expect(expectedSubjectLines).toBeGreaterThan(3);
});

test("computeOverlayRows: exact-multiple word subject returns correct rows", () => {
  const exactWord = "a".repeat(160);
  const rows = computeOverlayRows({
    gateContext: {
      pendingPermission: {
        action: "Run shell command",
        subject: exactWord,
        scopes: [{ pattern: null }],
      },
      pendingOperator: null,
    },
    modalContext: {
      helpOpen: false,
      hookPanelOpen: false,
      exitConfirmOpen: false,
      agentModalOpen: false,
      permissionsOpen: false,
      permissionEntryCount: 0,
    },
    hookCount: 0,
    providerCatalog: [],
    innerWidth: 80,
  });
  expect(rows).toBe(16);
});
