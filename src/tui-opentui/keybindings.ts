/**
 * OpenTUI shell keybinding catalog (pure data).
 *
 * This is the source of truth for the help overlay — every row here must
 * match a real handler in src/tui-opentui/shell.ts's `onKey`/`onEnter`
 * listeners. Do not hand-transcribe from docs or from the Ink renderer's
 * src/tui/keymap-table.ts, which describes a different key handler.
 */

export type ShellShortcut = {
  readonly keys: string
  readonly description: string
}

export const SHELL_SHORTCUTS: readonly ShellShortcut[] = [
  { keys: "Enter", description: "Queue message mid-run (badge); normal send when idle" },
  { keys: "Alt+Enter", description: "Steer at next tool boundary (only while busy)" },
  { keys: "Ctrl+C", description: "Interrupt current run, or clear prompt / exit when idle" },
  { keys: "Ctrl+O", description: "Open command palette" },
  { keys: "Alt+C", description: "Copy mode: pick a message, tool output, or diff" },
  { keys: "Tab", description: "Toggle prompt ↔ transcript focus" },
  { keys: "Esc", description: "Close overlay / leave subagent observe" },
] as const
