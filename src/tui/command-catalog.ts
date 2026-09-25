/**
 * Registry → `/` command list catalog (pure).
 *
 * Pure: host injects `listCommands()` results (or fixtures). No registry import
 * here — avoids circular / heavy deps from `src/tui/commands`.
 *
 *   setPaletteCatalog(shell, () => commandItemsFromRegistry(listCommands()))
 */

import { withOriginMarker } from "../plugins/origin-marker.js";
import type { PluginOrigin } from "../trust/project-trust.js";
import { sliceToWidth, stringWidth } from "./view/height.js";

/** Minimal subcommand shape — mirrors `SubcommandDefinition` without importing it. */
export interface RegistrySubcommandSource {
  readonly name: string;
  readonly description: string;
}

/** Minimal registry shape — matches `listCommands()` entries without importing them. */
export interface RegistryCommandSource {
  readonly name: string;
  readonly description: string;
  /** Discovery origin of the contributing plugin, when the command has one. */
  readonly origin?: PluginOrigin;
  /**
   * Free-form arg guidance (frontmatter `argument-hint`). Shown greyed in the
   * `/` popup row and spliced into the prompt as selected text on Tab so
   * typing replaces it. `undefined` means the command takes no params and
   * keeps today's bare `/id` accept behavior.
   */
  readonly argumentHint?: string;
  /** Named subcommands (frontmatter `subcommands`); offered as arg rows. */
  readonly subcommands?: readonly RegistrySubcommandSource[];
}

/** One entry in the `/` command list: registry command name + display label. */
export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  /** Optional keywords for name-prefix / substring filter. */
  readonly keywords?: readonly string[];
  /** Registry description for the overlay zone; rows stay name-only. */
  readonly description?: string;
  /** Carried arg guidance; rendered after the name in `/` rows. */
  readonly argumentHint?: string;
  /** Carried subcommands; offered as second-stage arg rows. */
  readonly subcommands?: readonly RegistrySubcommandSource[];
  /**
   * Render suffix for `/` rows (`/yolo [on|off|toggle]`); `label` itself
   * stays `/name` so the name-prefix filter is unchanged.
   */
  readonly hintLabel?: string;
  /** Second-stage arg rows only: the owning slash command id. */
  readonly parentId?: string;
  /** Second-stage rows only: text spliced after `/id ` on accept. */
  readonly argValue?: string;
  /** Second-stage rows only: subcommand choice vs hint reminder. */
  readonly argKind?: "subcommand" | "hint";
}

/** Map registry command definitions to `/` list items. */
export function commandItemsFromRegistry(
  commands: readonly RegistryCommandSource[],
): PaletteCommand[] {
  return commands.map((c) => {
    const subcommands =
      c.subcommands !== undefined && c.subcommands.length > 0
        ? [...c.subcommands]
        : undefined;
    // Explicit hint wins; otherwise derive `[a|b]` from subcommand names so
    // stage 1 still advertises that the command takes an argument.
    const hintLabel =
      c.argumentHint ??
      (subcommands !== undefined
        ? `[${subcommands.map((s) => s.name).join("|")}]`
        : undefined);
    const keywords = [c.name, c.description, "slash", "command"];
    if (c.argumentHint !== undefined) keywords.push(c.argumentHint);
    if (subcommands !== undefined) {
      for (const s of subcommands) keywords.push(s.name, s.description);
    }
    return {
      id: c.name,
      // Name-only rows keep the slash popup scannable; description is a
      // dedicated field for the overlay zone and stays in keywords so typed
      // filter still finds prose matches. Plugin rows carry their origin
      // marker ([bundled] for bundled, origin label otherwise).
      label: withOriginMarker(`/${c.name}`, c.origin),
      description: c.description,
      keywords,
      ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
      ...(subcommands !== undefined ? { subcommands } : {}),
      ...(hintLabel !== undefined ? { hintLabel } : {}),
    };
  });
}

/**
 * Second-stage arg rows for a command with params: subcommand choices
 * prefix-filtered by the typed arg, or the free-form hint as a single
 * reminder row while the arg is still empty. Pure; the popup branch in
 * `openSlashCommands` reuses these with in-place refresh.
 */
export function slashArgItems(
  cmd: PaletteCommand,
  arg: string,
): PaletteCommand[] {
  const q = arg.trim().toLowerCase();
  const subcommands = cmd.subcommands ?? [];
  if (subcommands.length > 0) {
    return subcommands
      .filter((s) => s.name.toLowerCase().startsWith(q))
      .map((s) => ({
        id: `${cmd.id}:${s.name}`,
        label: s.name,
        keywords: [s.name, s.description],
        description: s.description,
        parentId: cmd.id,
        argValue: s.name,
        argKind: "subcommand" as const,
      }));
  }
  if (cmd.argumentHint === undefined || q.length > 0) return [];
  return [
    {
      id: `${cmd.id}:hint`,
      label: cmd.argumentHint,
      keywords: [cmd.argumentHint],
      ...(cmd.description !== undefined
        ? { description: cmd.description }
        : {}),
      parentId: cmd.id,
      argValue: cmd.argumentHint,
      argKind: "hint" as const,
    },
  ];
}

/**
 * Bare base text (`/id `) when a value about to be submitted is still exactly
 * a Tab-accepted free-form hint: the hint lands as selected text so typing
 * replaces it, but submitting it untouched would send the placeholder as the
 * argument. The guard is deliberately shape-only, not selection-gated — the
 * untouched selection is trivially lost without editing (one arrow key), and
 * after that a bare Enter would still submit the literal. An exact `/id
 * <hint>` match is always the placeholder no matter how the selection was
 * lost: real arguments never equal the hint byte-for-byte. Pure;
 * `submitPrompt` applies the result. Returns null when the value is real
 * content (subcommand accepts, typed text, unknown commands, bare bases).
 */
export function stripUneditedSlashHint(
  catalog: readonly PaletteCommand[],
  value: string,
): string | null {
  if (!value.startsWith("/")) return null;
  const space = value.indexOf(" ");
  if (space < 0) return null;
  const tail = value.slice(space + 1);
  if (tail.length === 0) return null;
  const cmd = catalog.find(
    (c) => c.id.toLowerCase() === value.slice(1, space).toLowerCase(),
  );
  if (cmd?.argumentHint === undefined || cmd.argumentHint !== tail) return null;
  return value.slice(0, space + 1);
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

/** Labels for the shared list viewport. Hint suffixes ride along on `/` rows. */
export function paletteLabels(
  commands: readonly Pick<PaletteCommand, "label" | "hintLabel">[],
): readonly string[] {
  return commands.map((c) =>
    c.hintLabel !== undefined ? `${c.label} ${c.hintLabel}` : c.label,
  );
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
export function formatPaletteRows(
  labels: readonly string[],
  width: number,
): readonly string[] {
  return labels.map((label) => fitLabel(label, width));
}
