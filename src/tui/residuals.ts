/**
 * Residual list-overlay helpers + observe session types (pure, production).
 * Hosts build rows with {@link residualListFromCatalog} and resolve accept
 * callbacks via {@link residualIdFromSelection}; overlay openers require
 * `items` from the caller that owns the data. Demo/fixture data lives in
 * demo.ts, not here.
 */

import type { StreamRow } from "./stream.js";

/** Host-owned residual row: stable id + display label. */
export interface ResidualCatalogEntry {
  readonly id: string;
  readonly label: string;
}

export interface ResidualListPayload {
  readonly items: readonly string[];
  readonly itemIds: readonly string[];
}

/** Map host catalog entries → openListOverlay items + itemIds. */
export function residualListFromCatalog(
  entries: readonly ResidualCatalogEntry[],
): ResidualListPayload {
  return {
    items: entries.map((e) => e.label),
    itemIds: entries.map((e) => e.id),
  };
}

/**
 * Resolve the stable id for an accepted residual selection.
 * Prefers `selection.id`; falls back to itemIds[index] when provided.
 */
export function residualIdFromSelection(
  selection: { readonly index: number; readonly id?: string },
  itemIds?: readonly string[],
): string | undefined {
  if (selection.id !== undefined) return selection.id;
  if (itemIds === undefined) return undefined;
  return itemIds[selection.index];
}

export interface ObserveSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly description: string;
  readonly lines: readonly StreamRow[];
}
