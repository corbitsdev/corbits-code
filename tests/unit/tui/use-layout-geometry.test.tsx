import { test, expect } from "bun:test";
import {
  computeOverlayRows,
  computeVisibleRows,
  type GateContext,
  type ModalContext,
  type UseLayoutGeometryArgs,
} from "../../../src/tui/hooks/use-layout-geometry.js";
import type { ProviderCatalogEntry } from "../../../src/config/index.js";

const CHROME_ROWS = 9;

// Default empty modal and gate contexts
const noGates: GateContext = {
  pendingPermission: null,
  pendingPlan: null,
  pendingOperator: null,
};

const noModals: ModalContext = {
  helpOpen: false,
  hookPanelOpen: false,
  exitConfirmOpen: false,
  agentModalOpen: false,
  permissionsOpen: false,
  permissionEntryCount: 0,
};

type GeoArgs = {
  columns?: number;
  rows?: number;
  sidebarOpen?: boolean;
  gateContext?: GateContext;
  modalContext?: ModalContext;
  hookCount?: number;
  providerCatalog?: ProviderCatalogEntry[];
};

function computeGeo({
  columns = 100,
  rows = 40,
  sidebarOpen = false,
  gateContext = noGates,
  modalContext = noModals,
  hookCount = 0,
  providerCatalog = [],
}: GeoArgs = {}) {
  const leftWidth = sidebarOpen ? Math.floor(columns * 0.65) : columns;
  const rightWidth = columns - leftWidth;
  const effectiveOverlayRows = computeOverlayRows({
    gateContext,
    modalContext,
    hookCount,
    providerCatalog,
    innerWidth: leftWidth - 8,
  });
  const visibleRows = computeVisibleRows({
    rows,
    chromeRows: CHROME_ROWS,
    effectiveOverlayRows,
    extraChromeRows: 0,
  });
  const diffVisibleRows = Math.max(1, visibleRows - 2);
  return { leftWidth, rightWidth, visibleRows, diffVisibleRows, effectiveOverlayRows };
}

// 1. Sidebar closed: leftWidth === columns, rightWidth === 0
test("sidebar closed: leftWidth equals columns, rightWidth is 0", () => {
  const geo = computeGeo({ columns: 100, sidebarOpen: false });
  expect(geo.leftWidth).toBe(100);
  expect(geo.rightWidth).toBe(0);
});

// 2. Sidebar open: leftWidth = floor(columns * 0.65), rightWidth = columns - leftWidth
test("sidebar open: leftWidth is floor(columns * 0.65)", () => {
  const geo = computeGeo({ columns: 100, sidebarOpen: true });
  expect(geo.leftWidth).toBe(Math.floor(100 * 0.65));
  expect(geo.rightWidth).toBe(100 - Math.floor(100 * 0.65));
});

test("visibleRows equals rows - 9 - effectiveOverlayRows", () => {
  const geo = computeGeo({ rows: 40 });
  expect(geo.visibleRows).toBe(40 - 9 - geo.effectiveOverlayRows);
});

test("no modals or gates: effectiveOverlayRows is 0 and visibleRows is rows - 9", () => {
  const geo = computeGeo({ rows: 40 });
  expect(geo.effectiveOverlayRows).toBe(0);
  expect(geo.visibleRows).toBe(40 - 9);
});

// 5. helpOpen: true → effectiveOverlayRows === 16
test("helpOpen: effectiveOverlayRows is 16", () => {
  const geo = computeGeo({ modalContext: { ...noModals, helpOpen: true } });
  expect(geo.effectiveOverlayRows).toBe(16);
});

// 6. exitConfirmOpen: true → effectiveOverlayRows === 6
test("exitConfirmOpen: effectiveOverlayRows is 6", () => {
  const geo = computeGeo({
    modalContext: { ...noModals, exitConfirmOpen: true },
  });
  expect(geo.effectiveOverlayRows).toBe(6);
});

// 7. hookPanelOpen: true with hookCount=3 → effectiveOverlayRows === 4 + 3 = 7
test("hookPanelOpen with hookCount=3: effectiveOverlayRows is 7", () => {
  const geo = computeGeo({
    modalContext: { ...noModals, hookPanelOpen: true },
    hookCount: 3,
  });
  expect(geo.effectiveOverlayRows).toBe(7);
});

// exitConfirmOpen dedicated test
test("exitConfirmOpen: effectiveOverlayRows is 6", () => {
  const geo = computeGeo({
    modalContext: { ...noModals, exitConfirmOpen: true },
  });
  expect(geo.effectiveOverlayRows).toBe(6);
});

// 8. agentModalOpen with 2 providers each having 3 models → effectiveOverlayRows === 16 + max(2, 3) = 19
test("agentModalOpen with 2 providers each having 3 models: effectiveOverlayRows is 19", () => {
  const providerCatalog = [
    { id: "p1", name: "P1", models: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
    { id: "p2", name: "P2", models: [{ id: "m4" }, { id: "m5" }, { id: "m6" }] },
  ] as unknown as ProviderCatalogEntry[];
  const geo = computeGeo({
    modalContext: { ...noModals, agentModalOpen: true },
    providerCatalog,
  });
  expect(geo.effectiveOverlayRows).toBe(19);
});

// 9. pendingPlan: 8 fixed rows + 2 rows per step (file + action rows)
test("pendingPlan with 0 steps: effectiveOverlayRows is 8", () => {
  const geo = computeGeo({
    gateContext: { ...noGates, pendingPlan: [] },
  });
  expect(geo.effectiveOverlayRows).toBe(8);
});

test("pendingPlan with 3 steps: effectiveOverlayRows is 14", () => {
  const geo = computeGeo({
    gateContext: { ...noGates, pendingPlan: [1, 2, 3] },
  });
  expect(geo.effectiveOverlayRows).toBe(14);
});

// 10. pendingOperator with a short question and 4 short options → fixed (11) +
// 1 question line + 4 option lines + 2 (Other/Close) = 18.
test("pendingOperator with a short question and 4 options: effectiveOverlayRows is 18", () => {
  const geo = computeGeo({
    gateContext: {
      ...noGates,
      pendingOperator: { question: "Pick one", options: ["a", "b", "c", "d"] },
    },
  });
  expect(geo.effectiveOverlayRows).toBe(18);
});

// 11. A long question that wraps across many lines must reserve those rows so
// the event log does not overpaint the modal (the original overflow bug).
test("pendingOperator with a long wrapping question reserves the wrapped rows", () => {
  const longQuestion = Array.from({ length: 20 }, () => "word").join(" ").repeat(20);
  const geo = computeGeo({
    columns: 40,
    gateContext: {
      ...noGates,
      pendingOperator: { question: longQuestion, options: ["yes", "no"] },
    },
  });
  expect(geo.effectiveOverlayRows).toBeGreaterThan(20);
});

// 12. diffVisibleRows === max(1, visibleRows - 2)
test("diffVisibleRows is max(1, visibleRows - 2)", () => {
  const geo = computeGeo({ rows: 40 });
  expect(geo.diffVisibleRows).toBe(Math.max(1, geo.visibleRows - 2));
});

// Edge: very small rows → visibleRows and diffVisibleRows floor at 1
test("very small rows: visibleRows and diffVisibleRows floor at 1", () => {
  const geo = computeGeo({ rows: 5 });
  expect(geo.visibleRows).toBe(1);
  expect(geo.diffVisibleRows).toBe(1);
});

// Sidebar open with non-round columns
test("sidebar open with odd columns: widths sum to columns", () => {
  const geo = computeGeo({ columns: 133, sidebarOpen: true });
  expect(geo.leftWidth + geo.rightWidth).toBe(133);
  expect(geo.leftWidth).toBe(Math.floor(133 * 0.65));
});

// 13. pendingPermission with a multi-line shell subject (heredoc / script) must
// reserve the wrapped lines so the event log never overpaints the modal.
test("pendingPermission with multi-line shell script reserves wrapped rows", () => {
  const script = "cat << 'EOF'\n#!/usr/bin/env bash\necho 'hello world'\nEOF";
  const geo = computeGeo({
    columns: 80,
    gateContext: {
      ...noGates,
      pendingPermission: {
        action: "Run shell command",
        subject: script,
        scopes: [{ pattern: null }],
      },
    },
  });
  // A multi-line script wrapped to ~72 cols needs 4+ subject lines; the old
  // naive ceil(length/width) gave 1. 13 fixed + choices + subject lines.
  expect(geo.effectiveOverlayRows).toBeGreaterThan(16);
});
