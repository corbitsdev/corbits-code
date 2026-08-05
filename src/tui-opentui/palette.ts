/**
 * Command palette — Amp-class discovery catalog + filter (pure).
 * Ctrl+O opens (reclaimed from tool-expand); Esc restores prior focus.
 * Shell owns paint / focus stack via openPalette.
 */

export type PaletteActionId =
  | "permissions"
  | "operator"
  | "model_picker"
  | "toggle_goal"
  | "toggle_task"
  | "toggle_agents"
  | "copy_active"
  | "help"

export type PaletteCommand = {
  readonly id: PaletteActionId
  readonly label: string
  /** Optional keywords for fuzzy-ish filter. */
  readonly keywords?: readonly string[]
}

/** Default Amp-class discovery catalog (product actions, not slash-only). */
export const DEFAULT_PALETTE_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "permissions",
    label: "Open permissions",
    keywords: ["allow", "deny", "tool", "approve"],
  },
  {
    id: "operator",
    label: "Ask operator question",
    keywords: ["confirm", "choice", "prompt"],
  },
  {
    id: "model_picker",
    label: "Switch model / provider",
    keywords: ["model", "provider", "anthropic", "openai"],
  },
  {
    id: "toggle_goal",
    label: "Toggle goal chrome",
    keywords: ["goal", "chrome", "zone"],
  },
  {
    id: "toggle_task",
    label: "Toggle task chrome",
    keywords: ["task", "work", "chrome"],
  },
  {
    id: "toggle_agents",
    label: "Toggle agents strip",
    keywords: ["agents", "strip", "workers"],
  },
  {
    id: "copy_active",
    label: "Copy active message / tool",
    keywords: ["copy", "clipboard", "yank"],
  },
  {
    id: "help",
    label: "Show keymap help",
    keywords: ["keys", "bindings", "help"],
  },
] as const

/**
 * Case-insensitive substring filter over label + keywords.
 * Empty query returns the full catalog (stable order).
 */
export function filterPaletteCommands(
  query: string,
  catalog: readonly PaletteCommand[] = DEFAULT_PALETTE_COMMANDS,
): readonly PaletteCommand[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return catalog
  return catalog.filter((cmd) => {
    if (cmd.label.toLowerCase().includes(q)) return true
    if (cmd.id.toLowerCase().includes(q)) return true
    return (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q))
  })
}

/** Labels for the shared list viewport. */
export function paletteLabels(
  commands: readonly PaletteCommand[],
): readonly string[] {
  return commands.map((c) => c.label)
}
