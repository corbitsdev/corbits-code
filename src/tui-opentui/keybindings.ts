/**
 * OpenTUI shell keybinding catalog (pure data).
 *
 * This is the source of truth for the help overlay — every row here must
 * match a real, currently-working chord: either a handler in
 * src/tui-opentui/shell.ts's `onKey`/`onEnter` listeners, or a default
 * binding of the prompt's InputRenderable (see `defaultTextareaKeyBindings`
 * in @opentui/core — Ctrl+B/F/D, Alt+B/F, and arrow motion come from there,
 * not from shell.ts). Do not hand-transcribe from docs.
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
  { keys: "Ctrl+B / Ctrl+F", description: "Move cursor back / forward one character" },
  { keys: "Ctrl+D", description: "Delete character under cursor" },
  { keys: "Alt+B / Alt+F", description: "Move cursor back / forward one word" },
  { keys: "Ctrl+K", description: "Kill from cursor to end of prompt" },
  { keys: "Ctrl+U", description: "Kill from start of prompt to cursor" },
  { keys: "Ctrl+W", description: "Kill previous word" },
  { keys: "Alt+D", description: "Kill next word" },
  { keys: "Ctrl+Y", description: "Yank last kill at cursor" },
  { keys: "Alt+Y", description: "Cycle yank to the next-older kill" },
  { keys: "Arrow keys", description: "Move cursor left / right / up / down in prompt" },
] as const
