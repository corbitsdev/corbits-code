/**
 * Command palette — Amp-class discovery catalog + filter (pure).
 * Ctrl+O opens (reclaimed from tool-expand); Esc restores prior focus.
 * Shell owns paint / focus stack via openPalette.
 *
 * Catalog = residual product openers + optional registry-backed slash commands.
 * Registry import is NOT hard-wired here (avoids circular / heavy deps); the host
 * injects `listCommands()` results via `buildPaletteCatalog` / `openPalette` opts.
 */

/** Residual product actions owned by the shell (open overlays / chrome toggles). */
export type PaletteActionId =
  | "permissions"
  | "operator"
  | "model_picker"
  | "toggle_goal"
  | "toggle_task"
  | "toggle_agents"
  | "copy_active"
  | "help"
  | "settings"
  | "plugins"
  | "resume"
  | "mentions"
  | "observe"

const RESIDUAL_ACTION_IDS = new Set<string>([
  "permissions",
  "operator",
  "model_picker",
  "toggle_goal",
  "toggle_task",
  "toggle_agents",
  "copy_active",
  "help",
  "settings",
  "plugins",
  "resume",
  "mentions",
  "observe",
])

export function isResidualActionId(id: string): id is PaletteActionId {
  return RESIDUAL_ACTION_IDS.has(id)
}

/**
 * How select dispatches:
 * - residual — shell `runPaletteAction` (overlays / chrome)
 * - command — injectable `onCommand(name)` for registry slash commands
 */
export type PaletteDispatch = "residual" | "command"

/**
 * Grouping shown in the palette's first column.
 *
 * The command registry (`src/tui/commands/built-in.ts`) carries no category
 * field, and `RegistryCommandSource` only forwards name + description, so there
 * is no grouping to read. These are the smallest set that covers what the
 * registered commands and residual openers actually are; anything unmapped
 * falls back to `command` rather than being guessed into a group.
 */
export type PaletteCategory =
  | "session"
  | "model"
  | "config"
  | "view"
  | "agent"
  | "edit"
  | "command"

/** Registry command name → category. Names come from built-in.ts registrations. */
const REGISTRY_CATEGORIES: Readonly<Record<string, PaletteCategory>> = {
  clear: "session",
  new: "session",
  rename: "session",
  cost: "session",
  goal: "session",
  model: "model",
  fast: "model",
  standard: "model",
  clever: "model",
  settings: "config",
  permissions: "config",
  plugins: "config",
  mcp: "config",
  help: "view",
  changelog: "view",
  "paste-image": "edit",
}

export function categoryForCommandName(name: string): PaletteCategory {
  return REGISTRY_CATEGORIES[name] ?? "command"
}

export type PaletteCommand = {
  /** Residual action id or registry command name. */
  readonly id: string
  readonly label: string
  /** Optional keywords for fuzzy-ish filter. */
  readonly keywords?: readonly string[]
  /**
   * Select dispatch target. Defaults to residual when id is a known residual
   * action; registry-built items set `"command"` explicitly.
   */
  readonly dispatch?: PaletteDispatch
  /** Dim prefix column. Defaults to `command` when omitted. */
  readonly category?: PaletteCategory
}

/** Minimal registry shape — matches `listCommands()` entries without importing them. */
export type RegistryCommandSource = {
  readonly name: string
  readonly description: string
}

/** Default Amp-class residual openers (product actions, not slash-only). */
export const DEFAULT_PALETTE_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "permissions",
    label: "Open permissions",
    keywords: ["allow", "deny", "tool", "approve"],
    dispatch: "residual",
    category: "config",
  },
  {
    id: "operator",
    label: "Ask operator question",
    keywords: ["confirm", "choice", "prompt"],
    dispatch: "residual",
    category: "session",
  },
  {
    id: "model_picker",
    label: "Switch model / provider",
    keywords: ["model", "provider", "anthropic", "openai"],
    dispatch: "residual",
    category: "model",
  },
  {
    id: "toggle_goal",
    label: "Toggle goal chrome",
    keywords: ["goal", "chrome", "zone"],
    dispatch: "residual",
    category: "view",
  },
  {
    id: "toggle_task",
    label: "Toggle task chrome",
    keywords: ["task", "work", "chrome"],
    dispatch: "residual",
    category: "view",
  },
  {
    id: "toggle_agents",
    label: "Toggle agents strip",
    keywords: ["agents", "strip", "workers"],
    dispatch: "residual",
    category: "view",
  },
  {
    id: "copy_active",
    label: "Copy active message / tool",
    keywords: ["copy", "clipboard", "yank"],
    dispatch: "residual",
    category: "edit",
  },
  {
    id: "help",
    label: "Show keymap help",
    keywords: ["keys", "bindings", "help"],
    dispatch: "residual",
    category: "view",
  },
  {
    id: "settings",
    label: "Open settings",
    keywords: ["config", "preferences", "options"],
    dispatch: "residual",
    category: "config",
  },
  {
    id: "plugins",
    label: "Manage plugins",
    keywords: ["mcp", "extension", "plugin"],
    dispatch: "residual",
    category: "config",
  },
  {
    id: "resume",
    label: "Resume prior session",
    keywords: ["history", "session", "picker"],
    dispatch: "residual",
    category: "session",
  },
  {
    id: "mentions",
    label: "Insert file mention",
    keywords: ["@", "path", "file", "mention"],
    dispatch: "residual",
    category: "edit",
  },
  {
    id: "observe",
    label: "Observe subagent session",
    keywords: ["child", "worker", "observe", "agents"],
    dispatch: "residual",
    category: "agent",
  },
]

/**
 * Map registry command definitions to palette items.
 * Caller filters hidden via `listCommands()` (or fixture) before passing.
 */
export function commandsToPaletteItems(
  commands: readonly RegistryCommandSource[],
): PaletteCommand[] {
  return commands.map((c) => ({
    id: c.name,
    label: `/${c.name} — ${c.description}`,
    keywords: [c.name, "slash", "command"],
    dispatch: "command" as const,
    category: categoryForCommandName(c.name),
  }))
}

export type BuildPaletteCatalogOpts = {
  /** Residual openers. Defaults to DEFAULT_PALETTE_COMMANDS. */
  readonly residuals?: readonly PaletteCommand[]
  /**
   * Registry-shaped commands (from `listCommands()` or test fixtures).
   * Already filtered for hidden / availability by the source.
   */
  readonly commands?: readonly RegistryCommandSource[]
  /**
   * When true (default), skip residual openers whose id matches a registry
   * command name so slash entries win for discovery of real handlers.
   * Residual-only product actions (toggle_*, copy_active, …) always remain.
   */
  readonly preferRegistry?: boolean
}

/**
 * Build a palette catalog from residual openers + optional registry commands.
 * Pure — no registry import; host injects `listCommands()` results.
 */
export function buildPaletteCatalog(
  opts?: BuildPaletteCatalogOpts,
): readonly PaletteCommand[] {
  const residuals = opts?.residuals ?? DEFAULT_PALETTE_COMMANDS
  const commands = opts?.commands ?? []
  const preferRegistry = opts?.preferRegistry !== false

  const registryNames = new Set(commands.map((c) => c.name))
  const residualItems =
    preferRegistry && registryNames.size > 0
      ? residuals.filter((r) => !registryNames.has(r.id))
      : [...residuals]

  const commandItems = commandsToPaletteItems(commands)
  return [...residualItems, ...commandItems]
}

/**
 * Resolve dispatch for a palette item.
 * Explicit `dispatch` wins; else residual if id is a known residual action.
 */
export function paletteDispatchOf(cmd: PaletteCommand): PaletteDispatch {
  if (cmd.dispatch === "command" || cmd.dispatch === "residual") {
    return cmd.dispatch
  }
  return isResidualActionId(cmd.id) ? "residual" : "command"
}

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

/** One palette row before it is fitted to a width. */
export type PaletteRowColumns = {
  readonly category: string
  readonly label: string
  /** Empty when the entry has no chord. */
  readonly shortcut: string
}

export function paletteRowColumns(
  cmd: PaletteCommand,
  shortcutOf: (id: string) => string | undefined,
): PaletteRowColumns {
  return {
    category: cmd.category ?? "command",
    label: cmd.label,
    shortcut: shortcutOf(cmd.id) ?? "",
  }
}

/** Columns the label must keep before a side column is dropped. */
const PALETTE_LABEL_MIN = 28
const PALETTE_COL_GAP = 2

export type PaletteRowLayout = {
  readonly showCategory: boolean
  readonly showShortcut: boolean
  readonly categoryWidth: number
  readonly shortcutWidth: number
}

/**
 * Which columns survive at `width`. The shortcut goes first because it is
 * redundant — the row it labels is right there and can be selected instead.
 * The category goes second; the label alone is never dropped.
 */
export function paletteRowLayout(
  rows: readonly PaletteRowColumns[],
  width: number,
): PaletteRowLayout {
  const categoryWidth = rows.reduce((n, r) => Math.max(n, r.category.length), 0)
  const shortcutWidth = rows.reduce((n, r) => Math.max(n, r.shortcut.length), 0)
  const afterCategory =
    width - (categoryWidth > 0 ? categoryWidth + PALETTE_COL_GAP : 0)
  const showShortcut =
    shortcutWidth > 0 &&
    afterCategory - shortcutWidth - PALETTE_COL_GAP >= PALETTE_LABEL_MIN
  const showCategory = categoryWidth > 0 && afterCategory >= PALETTE_LABEL_MIN
  return { showCategory, showShortcut, categoryWidth, shortcutWidth }
}

function fitLabel(label: string, width: number): string {
  if (width <= 0) return ""
  if (label.length <= width) return label.padEnd(width)
  if (width === 1) return "…"
  return `${label.slice(0, width - 1)}…`
}

/**
 * Render rows to exactly `width` columns: dim category, label, right-aligned
 * chord. Column widths are shared across the batch so the three columns line up.
 */
export function formatPaletteRows(
  rows: readonly PaletteRowColumns[],
  width: number,
): readonly string[] {
  const layout = paletteRowLayout(rows, width)
  const head = layout.showCategory ? layout.categoryWidth + PALETTE_COL_GAP : 0
  const tail = layout.showShortcut ? layout.shortcutWidth + PALETTE_COL_GAP : 0
  const labelWidth = Math.max(0, width - head - tail)
  return rows.map((row) => {
    const category = layout.showCategory
      ? row.category.padEnd(layout.categoryWidth) + " ".repeat(PALETTE_COL_GAP)
      : ""
    const shortcut = layout.showShortcut
      ? " ".repeat(PALETTE_COL_GAP) + row.shortcut.padStart(layout.shortcutWidth)
      : ""
    return `${category}${fitLabel(row.label, labelWidth)}${shortcut}`
  })
}
