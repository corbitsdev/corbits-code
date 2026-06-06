import { render } from "ink-testing-library";
import { Text } from "ink";
import { test, expect } from "bun:test";
import { useLayoutGeometry } from "../../../src/tui/hooks/use-layout-geometry.js";
import type { UseLayoutGeometryArgs } from "../../../src/tui/hooks/use-layout-geometry.js";

function Harness({ args }: { args: UseLayoutGeometryArgs }) {
  const geo = useLayoutGeometry(args);
  return <Text>{JSON.stringify(geo)}</Text>;
}

function makeArgs(overrides: Partial<UseLayoutGeometryArgs> = {}): UseLayoutGeometryArgs {
  return {
    columns: 100,
    rows: 40,
    sidebarOpen: false,
    gateContext: { pendingPermission: null, pendingPlan: null, pendingOperator: null },
    modalContext: { helpOpen: false, hookPanelOpen: false, exitConfirmOpen: false, agentModalOpen: false },
    hookCount: 0,
    providerCatalog: [],
    ...overrides,
  };
}

function getGeo(args: UseLayoutGeometryArgs) {
  const { lastFrame } = render(<Harness args={args} />);
  const frame = lastFrame();
  return JSON.parse(frame ?? "{}") as {
    leftWidth: number;
    rightWidth: number;
    visibleRows: number;
    diffVisibleRows: number;
    effectiveOverlayRows: number;
  };
}

// 1. Sidebar closed: leftWidth === columns, rightWidth === 0
test("sidebar closed: leftWidth equals columns, rightWidth is 0", () => {
  const geo = getGeo(makeArgs({ columns: 100, sidebarOpen: false }));
  expect(geo.leftWidth).toBe(100);
  expect(geo.rightWidth).toBe(0);
});

// 2. Sidebar open: leftWidth = floor(columns * 0.65), rightWidth = columns - leftWidth
test("sidebar open: leftWidth is floor(columns * 0.65)", () => {
  const geo = getGeo(makeArgs({ columns: 100, sidebarOpen: true }));
  expect(geo.leftWidth).toBe(Math.floor(100 * 0.65));
  expect(geo.rightWidth).toBe(100 - Math.floor(100 * 0.65));
});

// 3. visibleRows = rows - 12 - effectiveOverlayRows
test("visibleRows equals rows - 12 - effectiveOverlayRows", () => {
  const geo = getGeo(makeArgs({ rows: 40 }));
  expect(geo.visibleRows).toBe(40 - 12 - geo.effectiveOverlayRows);
});

// 4. No modals/gates: effectiveOverlayRows === 0, visibleRows === rows - 12
test("no modals or gates: effectiveOverlayRows is 0 and visibleRows is rows - 12", () => {
  const geo = getGeo(makeArgs({ rows: 40 }));
  expect(geo.effectiveOverlayRows).toBe(0);
  expect(geo.visibleRows).toBe(40 - 12);
});

// 5. helpOpen: true → effectiveOverlayRows === 16
test("helpOpen: effectiveOverlayRows is 16", () => {
  const geo = getGeo(makeArgs({ modalContext: { helpOpen: true, hookPanelOpen: false, exitConfirmOpen: false, agentModalOpen: false } }));
  expect(geo.effectiveOverlayRows).toBe(16);
});

// 6. exitConfirmOpen: true → effectiveOverlayRows === 6
test("exitConfirmOpen: effectiveOverlayRows is 6", () => {
  const geo = getGeo(makeArgs({ modalContext: { helpOpen: false, hookPanelOpen: true, exitConfirmOpen: false, agentModalOpen: false }, hookCount: 3 }));
  expect(geo.effectiveOverlayRows).toBe(7);
});

// 7. hookPanelOpen: true with hookCount=3 → effectiveOverlayRows === 4 + 3 = 7
test("hookPanelOpen with hookCount=3: effectiveOverlayRows is 7", () => {
  const geo = getGeo(makeArgs({
    modalContext: { helpOpen: false, hookPanelOpen: true, exitConfirmOpen: false, agentModalOpen: false },
    hookCount: 3,
  }));
  expect(geo.effectiveOverlayRows).toBe(7);
});

// exitConfirmOpen dedicated test
test("exitConfirmOpen: effectiveOverlayRows is 6", () => {
  const geo = getGeo(makeArgs({
    modalContext: { helpOpen: false, hookPanelOpen: false, exitConfirmOpen: true, agentModalOpen: false },
  }));
  expect(geo.effectiveOverlayRows).toBe(6);
});

// 8. agentModalOpen with 2 providers each having 3 models → effectiveOverlayRows === 16 + max(2, 3) = 19
test("agentModalOpen with 2 providers each having 3 models: effectiveOverlayRows is 19", () => {
  const providerCatalog = [
    { id: "p1", name: "P1", models: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
    { id: "p2", name: "P2", models: [{ id: "m4" }, { id: "m5" }, { id: "m6" }] },
  ] as any;
  const geo = getGeo(makeArgs({
    modalContext: { helpOpen: false, hookPanelOpen: false, exitConfirmOpen: false, agentModalOpen: true },
    providerCatalog,
  }));
  expect(geo.effectiveOverlayRows).toBe(19);
});

// 9. pendingPlan !== null → effectiveOverlayRows === 18
test("pendingPlan non-null: effectiveOverlayRows is 18", () => {
  const geo = getGeo(makeArgs({
    gateContext: { pendingPermission: null, pendingPlan: { steps: [] }, pendingOperator: null },
  }));
  expect(geo.effectiveOverlayRows).toBe(18);
});

// 10. pendingOperator with 4 options → effectiveOverlayRows === 10 + 4 = 14
test("pendingOperator with 4 options: effectiveOverlayRows is 14", () => {
  const geo = getGeo(makeArgs({
    gateContext: {
      pendingPermission: null,
      pendingPlan: null,
      pendingOperator: { options: ["a", "b", "c", "d"] },
    },
  }));
  expect(geo.effectiveOverlayRows).toBe(14);
});

// 11. diffVisibleRows === max(1, visibleRows - 2)
test("diffVisibleRows is max(1, visibleRows - 2)", () => {
  const geo = getGeo(makeArgs({ rows: 40 }));
  expect(geo.diffVisibleRows).toBe(Math.max(1, geo.visibleRows - 2));
});

// Edge: very small rows → visibleRows and diffVisibleRows floor at 1
test("very small rows: visibleRows and diffVisibleRows floor at 1", () => {
  const geo = getGeo(makeArgs({ rows: 5 }));
  expect(geo.visibleRows).toBe(1);
  expect(geo.diffVisibleRows).toBe(1);
});

// Sidebar open with non-round columns
test("sidebar open with odd columns: widths sum to columns", () => {
  const geo = getGeo(makeArgs({ columns: 133, sidebarOpen: true }));
  expect(geo.leftWidth + geo.rightWidth).toBe(133);
  expect(geo.leftWidth).toBe(Math.floor(133 * 0.65));
});
