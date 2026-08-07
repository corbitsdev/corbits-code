/**
 * OpenTUI shell keybinding catalog (pure data).
 *
 * This is the source of truth for the help overlay — every row here must
 * match a real, currently-working chord: either a handler in
 * src/tui-opentui/shell.ts's `onKey`/`onEnter` listeners, or a default
 * binding of the prompt's InputRenderable (see `defaultTextareaKeyBindings`
 * in @opentui/core — Ctrl+B/F/D, Alt+B/F, and arrow motion come from there,
 * not from shell.ts). Do not hand-transcribe from docs.
 *
 * The comment alone did not hold: two rows drifted into describing behavior the
 * shell never had. `keybindings.test.ts` now drives every row's own chord
 * through a live shell and asserts the effect it claims, so a row that stops
 * being true fails rather than being read by an operator.
 */

export type ShellShortcut = {
  readonly keys: string
  readonly description: string
}

export const SHELL_SHORTCUTS: readonly ShellShortcut[] = [
  { keys: "Enter", description: "queue the message mid-run (badge); send straight through when idle" },
  { keys: "Alt+Enter", description: "steer at the next tool boundary; does nothing unless a run is busy" },
  { keys: "Ctrl+C", description: "interrupt the run, or clear the prompt when idle; press twice to exit" },
  { keys: "Ctrl+O", description: "open the command palette; press again to close it" },
  { keys: "Alt+C", description: "copy mode: pick a message, tool output, or diff; press again to close it" },
  { keys: "Alt+M", description: "release the mouse to the terminal for native drag-select and copy; on by default for wheel scroll and click-to-expand" },
  { keys: "Alt+E", description: "expand or collapse every collapsible row (tool call, diff, skill, reasoning)" },
  { keys: "Tab", description: "move focus between the prompt and the transcript" },
  { keys: "Esc", description: "close the open overlay, or leave subagent observe" },
  { keys: "Ctrl+B / Ctrl+F", description: "move the cursor back / forward one character" },
  { keys: "Ctrl+D", description: "delete the character under the cursor" },
  { keys: "Alt+B / Alt+F", description: "move the cursor back / forward one word" },
  { keys: "Ctrl+K", description: "kill from the cursor to the end of the line" },
  { keys: "Ctrl+U", description: "kill from the start of the line to the cursor" },
  { keys: "Ctrl+W", description: "kill the previous word" },
  { keys: "Alt+D", description: "kill the next word" },
  { keys: "Ctrl+Y", description: "yank the last kill at the cursor" },
  { keys: "Alt+Y", description: "replace the text just yanked with the next-older kill" },
  { keys: "Ctrl+V / Ctrl+P", description: "attach an image from the clipboard to the next message" },
  { keys: "?", description: "with the transcript focused, open this shortcut list; press again to close it" },
  { keys: "@", description: "at the start of a word, open file suggestions for the @mention being typed" },
  { keys: "/", description: "at an empty prompt, open the command list (Tab completes, Enter runs)" },
  { keys: "Up / Down", description: "recall previously sent messages, from the prompt's first / last row" },
  { keys: "Arrow keys", description: "move the cursor left / right / up / down in the prompt" },
  {
    keys: "Ctrl+Enter / Ctrl+J",
    description:
      "insert a newline instead of sending (Shift+Enter also works on terminals that report the modifier)",
  },
] as const

/**
 * Palette entry id (residual action id or registry command name) → the chord
 * that reaches the same surface without the palette.
 */
const PALETTE_CHORDS: Readonly<Record<string, string>> = {
  help: "?",
  mentions: "@",
  copy_active: "Alt+C",
  toggle_mouse: "Alt+M",
  "paste-image": "Ctrl+V / Ctrl+P",
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
