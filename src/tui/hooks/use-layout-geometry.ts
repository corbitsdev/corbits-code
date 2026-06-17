import { useMemo } from "react";
import type { ProviderCatalogEntry } from "../../config/index.js";

export type GateContext = {
  pendingPermission: {
    action: string;
    subject: string;
    scopes: Array<{ pattern: string | null }>;
  } | null;
  pendingPlan: unknown | null;
  pendingOperator: { question: string; options: unknown[] } | null;
};

// Count the lines a string occupies when word-wrapped to `width` columns,
// mirroring Ink's wrap="wrap" behaviour (hard breaks on "\n", greedy word
// packing, long words split across lines). Used to reserve enough overlay rows
// for variable-length modal text so the event log never overpaints into it.
export function wrappedLineCount(text: string, width: number): number {
  const safeWidth = Math.max(1, width);
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines += 1;
      continue;
    }
    let col = 0;
    let lineCount = 1;
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      if (word.length > safeWidth) {
        if (col > 0) lineCount += 1;
        lineCount += Math.ceil(word.length / safeWidth) - 1;
        col = word.length % safeWidth;
        if (col === 0) col = safeWidth;
        continue;
      }
      const needed = col === 0 ? word.length : col + 1 + word.length;
      if (needed > safeWidth) {
        lineCount += 1;
        col = word.length;
      } else {
        col = needed;
      }
    }
    lines += lineCount;
  }
  return Math.max(1, lines);
}

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
    const subjectLines = wrappedLineCount(head, innerWidth);
    const persistable = gateContext.pendingPermission.scopes.filter((s) => s.pattern !== null).length;
    const choices = 2 + persistable;
    return 11 + subjectLines + choices;
  }
  if (gateContext.pendingPlan !== null) {
    const steps = Array.isArray(gateContext.pendingPlan) ? (gateContext.pendingPlan as unknown[]).length : 0;
    return 8 + steps * 2;
  }
  if (gateContext.pendingOperator !== null) {
    // Fixed chrome: border (2) + paddingY (2) + marginY (2) + title (1) +
    // marginTop before the question, options, and footer (3) + footer hint (1).
    const FIXED = 11;
    const questionLines = wrappedLineCount(gateContext.pendingOperator.question, innerWidth);
    // Each option is prefixed by an arrow + gap (2 cols) and may wrap. The
    // "Other" and "Close" entries always sit below the offered options.
    const optionWidth = Math.max(1, innerWidth - 2);
    const optionLines = gateContext.pendingOperator.options.reduce<number>(
      (n, opt) => n + wrappedLineCount(String(opt), optionWidth),
      0,
    );
    return FIXED + questionLines + optionLines + 2;
  }
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
