/**
 * OpenTUI shell keybinding catalog (pure data).
 *
 * This is the source of truth for the help overlay — every row here must
 * match a real, currently-working chord: either a handler in
 * src/tui/shell.ts's `onKey`/`onEnter` listeners, or a default
 * binding of the prompt's InputRenderable (see `defaultTextareaKeyBindings`
 * in @opentui/core — Ctrl+B/F/D, Alt+B/F, and arrow motion come from there,
 * not from shell.ts). Do not hand-transcribe from docs.
 *
 * The comment alone did not hold: two rows drifted into describing behavior the
 * shell never had. `keybindings.test.ts` now drives every row's own chord
 * through a live shell and asserts the effect it claims, so a row that stops
 * being true fails rather than being read by an operator.
 */

export interface ShellShortcut {
  readonly keys: string;
  readonly description: string;
}

export const SHELL_SHORTCUTS: readonly ShellShortcut[] = [
  {
    keys: "Enter",
    description:
      "soft-steer at the next tool boundary while busy (badge); send straight through when idle",
  },
  {
    keys: "Alt+Enter",
    description:
      "queue a follow-up delivered only when the run goes idle; does nothing unless a run is busy",
  },
  {
    keys: "Ctrl+C",
    description: "interrupt the run, or clear the prompt when idle; press twice to exit",
  },
  {
    keys: "Ctrl+G",
    description: "cancel the most recently queued or steered message before it dispatches",
  },
  {
    keys: "Alt+C",
    description: "copy mode: pick a message, tool output, or diff; press again to close it",
  },
  {
    keys: "Alt+M",
    description:
      "toggle DEC mouse capture (on by default: wheel scroll, click-to-expand, drag-to-copy); off restores native terminal drag-select",
  },
  {
    keys: "Alt+E",
    description: "expand or collapse every collapsible row (tool call, diff, skill, reasoning)",
  },
  { keys: "Alt+T", description: "show or hide the task list above the prompt (hidden by default)" },
  {
    keys: "Alt+O",
    description: "observe a live subagent session; a system row says so when there is none",
  },
  { keys: "Tab", description: "move focus between the prompt and the transcript" },
  { keys: "Shift+Tab", description: "cycle reasoning effort for the current model" },
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
  {
    keys: "Ctrl+V / Ctrl+P",
    description: "attach an image from the clipboard to the next message",
  },
  {
    keys: "@",
    description: "at the start of a word, open file suggestions for the @mention being typed",
  },
  {
    keys: "/",
    description:
      "at an empty prompt, open the command list (Tab completes, Enter runs); also lists /help",
  },
  {
    keys: "Up / Down",
    description: "recall previously sent messages, from the prompt's first / last row",
  },
  { keys: "Arrow keys", description: "move the cursor left / right / up / down in the prompt" },
  {
    keys: "Ctrl+Enter / Ctrl+J",
    description:
      "insert a newline instead of sending (Shift+Enter also works on terminals that report the modifier)",
  },
] as const;

/** Help rows derived from the shell's own keybinding catalog, so they cannot
 * drift from what the shell actually implements — there is no host dependency
 * to omit, so this never takes user-supplied items. */
export function helpItems(): readonly string[] {
  return [...SHELL_SHORTCUTS.map((s) => `${s.keys} — ${s.description}`), "Close help"];
}
