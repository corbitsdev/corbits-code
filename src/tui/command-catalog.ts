/**
 * Registry → `/` command list catalog (pure).
 *
 * Pure: host injects `listCommands()` results (or fixtures). No registry import
 * here — avoids circular / heavy deps from `src/tui/commands`.
 *
 *   setPaletteCatalog(shell, () => commandItemsFromRegistry(listCommands()))
 */

import { sliceToWidth, stringWidth } from "./view/height.js";

/** Minimal registry shape — matches `listCommands()` entries without importing them. */
export interface RegistryCommandSource {
  readonly name: string;
  readonly description: string;
}

/** One entry in the `/` command list: registry command name + display label. */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  /** Optional keywords for name-prefix / substring filter. */
  readonly keywords?: readonly string[];
  /** Registry description for the overlay zone; rows stay name-only. */
  readonly description?: string;
}

/** Map registry command definitions to `/` list items. */
export function commandItemsFromRegistry(
  commands: readonly RegistryCommandSource[],
): PaletteCommand[] {
  return commands.map((c) => ({
    id: c.name,
    // Name-only rows keep the slash popup scannable; description is a
    // dedicated field for the overlay zone and stays in keywords so typed
    // filter still finds prose matches.
    label: `/${c.name}`,
    description: c.description,
    keywords: [c.name, c.description, "slash", "command"],
  }));
}

/**
 * Case-insensitive substring filter over label + keywords.
 * Empty query returns the full catalog (stable order).
 */
export function filterPaletteCommands(
  query: string,
  catalog: readonly PaletteCommand[],
): readonly PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return catalog;
  return catalog.filter((cmd) => {
    if (cmd.label.toLowerCase().includes(q)) return true;
    if (cmd.id.toLowerCase().includes(q)) return true;
    return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  });
}

/** Labels for the shared list viewport. */
export function paletteLabels(commands: readonly PaletteCommand[]): readonly string[] {
  return commands.map((c) => c.label);
}

function fitLabel(label: string, width: number): string {
  if (width <= 0) return "";
  const columns = stringWidth(label);
  // padEnd counts code units, so a label carrying a wide glyph has to be padded
  // by the column shortfall rather than to a code-unit length.
  if (columns <= width) return label + " ".repeat(width - columns);
  if (width === 1) return "…";
  const cut = `${sliceToWidth(label, width - 1)}…`;
  return cut + " ".repeat(Math.max(0, width - stringWidth(cut)));
}

/** Render labels to exactly `width` columns each, ellipsizing long ones. */
export function formatPaletteRows(labels: readonly string[], width: number): readonly string[] {
  return labels.map((label) => fitLabel(label, width));
}
