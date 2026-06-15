import { useMemo } from "react";
import type { ProviderCatalogEntry } from "../../config/index.js";

export type GateContext = {
  pendingPermission: {
    action: string;
    subject: string;
    scopes: Array<{ pattern: string | null }>;
  } | null;
  pendingPlan: unknown | null;
  pendingOperator: { options: unknown[] } | null;
};

export type ModalContext = {
  helpOpen: boolean;
  hookPanelOpen: boolean;
  exitConfirmOpen: boolean;
  agentModalOpen: boolean;
  permissionsOpen: boolean;
  permissionEntryCount: number;
};

export type UseLayoutGeometryArgs = {
  columns: number;
  rows: number;
  sidebarOpen: boolean;
  gateContext: GateContext;
  modalContext: ModalContext;
  hookCount: number;
  providerCatalog: ProviderCatalogEntry[];
  // Additional chrome rows rendered outside the overlay accounting (e.g.
  // McpAuthPrompt, commandMessage). Must be subtracted so the log does not
  // overpaint into content below it.
  extraChromeRows?: number;
};

export type ComputeVisibleRowsArgs = {
  rows: number;
  chromeRows: number;
  effectiveOverlayRows: number;
  extraChromeRows: number;
};

export function computeVisibleRows({ rows, chromeRows, effectiveOverlayRows, extraChromeRows }: ComputeVisibleRowsArgs): number {
  return Math.max(1, rows - chromeRows - effectiveOverlayRows - extraChromeRows);
}

// Fixed chrome: title + border + section headers + footer hint inside the overlay.
const PERMISSIONS_OVERLAY_FIXED = 6;
// Cap so the overlay never consumes more than this many rows.
const PERMISSIONS_OVERLAY_MAX = 20;

export type LayoutGeometry = {
  leftWidth: number;
  rightWidth: number;
  visibleRows: number;
  diffVisibleRows: number;
  effectiveOverlayRows: number;
  permissionsOverlayRows: number;
};

// 2-line header (worst case) + input row + padding; over-reserves by one row on a fresh session by design.
const CHROME_ROWS = 10;

export type ComputeOverlayRowsArgs = {
  gateContext: GateContext;
  modalContext: ModalContext;
  hookCount: number;
  providerCatalog: ProviderCatalogEntry[];
  innerWidth: number;
};

export function computeOverlayRows({
  gateContext,
  modalContext,
  hookCount,
  providerCatalog,
  innerWidth,
}: ComputeOverlayRowsArgs): number {
  if (gateContext.pendingPermission !== null) {
    const head = `${gateContext.pendingPermission.action}: ${gateContext.pendingPermission.subject}`;
    const subjectLines = Math.max(1, Math.ceil(head.length / Math.max(8, innerWidth)));
    const persistable = gateContext.pendingPermission.scopes.filter((s) => s.pattern !== null).length;
    const choices = 2 + persistable;
    return 11 + subjectLines + choices;
  }
  if (gateContext.pendingPlan !== null) {
    const steps = Array.isArray(gateContext.pendingPlan) ? (gateContext.pendingPlan as unknown[]).length : 0;
    return 8 + steps * 2;
  }
  if (gateContext.pendingOperator !== null) return 10 + gateContext.pendingOperator.options.length;
  if (modalContext.helpOpen) return 16;
  if (modalContext.hookPanelOpen) return 4 + hookCount;
  if (modalContext.exitConfirmOpen) return 6;
  if (modalContext.agentModalOpen) {
    const widestModels = providerCatalog.reduce((n, p) => Math.max(n, p.models.length), 0);
    return 16 + Math.max(providerCatalog.length, widestModels);
  }
  return 0;
}

export function useLayoutGeometry({
  columns,
  rows,
  sidebarOpen,
  gateContext,
  modalContext,
  hookCount,
  providerCatalog,
  extraChromeRows = 0,
}: UseLayoutGeometryArgs): LayoutGeometry {
  const leftWidth = sidebarOpen ? Math.floor(columns * 0.65) : columns;
  const rightWidth = columns - leftWidth;

  const overlayRows = useMemo(() => computeOverlayRows({
    gateContext,
    modalContext,
    hookCount,
    providerCatalog,
    innerWidth: leftWidth - 8,
  }), [
    gateContext.pendingPermission,
    gateContext.pendingPlan,
    gateContext.pendingOperator,
    modalContext.helpOpen,
    modalContext.hookPanelOpen,
    modalContext.exitConfirmOpen,
    modalContext.agentModalOpen,
    providerCatalog,
    leftWidth,
    hookCount,
  ]);

  const effectiveOverlayRows = overlayRows;

  const permissionsOverlayRows = modalContext.permissionsOpen
    ? Math.min(PERMISSIONS_OVERLAY_MAX, PERMISSIONS_OVERLAY_FIXED + modalContext.permissionEntryCount)
    : 0;

  const visibleRows = computeVisibleRows({
    rows,
    chromeRows: CHROME_ROWS,
    effectiveOverlayRows: effectiveOverlayRows + permissionsOverlayRows,
    extraChromeRows,
  });
  const diffVisibleRows = Math.max(1, visibleRows - 2);

  return { leftWidth, rightWidth, visibleRows, diffVisibleRows, effectiveOverlayRows, permissionsOverlayRows };
}
