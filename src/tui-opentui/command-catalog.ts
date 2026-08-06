/**
 * Registry → palette catalog bridge for OpenTUI production host.
 *
 * Pure: host injects `listCommands()` results (or fixtures). No registry import
 * here — avoids circular / heavy deps from `src/tui/commands`.
 *
 *   setPaletteCatalog(shell, buildCommandCatalog(listCommands()))
 */

import {
  buildPaletteCatalog,
  commandsToPaletteItems,
  type BuildPaletteCatalogOpts,
  type PaletteCommand,
  type RegistryCommandSource,
} from "./palette.js"

export type { PaletteCommand, RegistryCommandSource }

export type BuildCommandCatalogOpts = Omit<BuildPaletteCatalogOpts, "commands">

/**
 * Map `listCommands()`-shaped entries into a palette catalog for setPaletteCatalog.
 *
 * Includes residual product openers (permissions, model picker, …) plus registry
 * slash commands with `dispatch: "command"` and `id` = command name. Registry
 * names win over residual openers with the same id (preferRegistry default).
 */
export function buildCommandCatalog(
  commands: readonly RegistryCommandSource[],
  opts?: BuildCommandCatalogOpts,
): readonly PaletteCommand[] {
  return buildPaletteCatalog({
    ...opts,
    commands,
  })
}

/**
 * Registry slash entries only (no residual openers). Each item has
 * `dispatch: "command"` and `id` equal to the command name.
 */
export function commandItemsFromRegistry(
  commands: readonly RegistryCommandSource[],
): PaletteCommand[] {
  return commandsToPaletteItems(commands)
}
