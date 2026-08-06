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
  { keys: "Ctrl+C", description: "Interrupt current run or clear prompt; press twice to exit" },
  { keys: "Ctrl+O", description: "Open the command palette; press again to close it" },
  { keys: "Alt+C", description: "Copy mode: pick a message, tool output, or diff (press again to close)" },
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
  { keys: "Ctrl+P", description: "Attach an image from the clipboard to the next message" },
  { keys: "?", description: "With the transcript focused, open this shortcut list; press again to close it" },
  { keys: "@", description: "Open file suggestions for the @mention being typed" },
  { keys: "/", description: "At an empty prompt, open the command list (Tab completes, Enter runs)" },
  { keys: "Up / Down", description: "Recall previously sent messages at the prompt's first / last row" },
  { keys: "Arrow keys", description: "Move cursor left / right / up / down in prompt" },
  { keys: "Shift+Enter / Ctrl+J", description: "Insert a newline instead of sending" },
] as const

/**
 * Palette entry id (residual action id or registry command name) → the chord
 * that reaches the same surface without the palette.
 */
const PALETTE_CHORDS: Readonly<Record<string, string>> = {
  help: "?",
  mentions: "@",
  copy_active: "Alt+C",
  "paste-image": "Ctrl+P",
}

/**
 * Chord to advertise for a palette row, or undefined when the entry has none.
 * Resolved against SHELL_SHORTCUTS so the palette can never print a binding the
 * shell does not actually implement.
 */
export function shortcutForPaletteId(id: string): string | undefined {
  const keys = PALETTE_CHORDS[id]
  if (keys === undefined) return undefined
  return SHELL_SHORTCUTS.some((s) => s.keys === keys) ? keys : undefined
}
