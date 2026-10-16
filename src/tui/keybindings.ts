/**
 * OpenTUI shell keybinding catalog (pure data) — the help overlay's source
 * of truth. Rows with `command` are application chords registered on
 * `@opentui/keymap`. Rows without one stay prompt-local: textarea defaults,
 * the kill ring, or a chord whose meaning depends on context keys.ts still
 * owns. `keybindings.test.ts` drives every row through a live shell.
 */

export interface ShellShortcut {
  readonly keys: string;
  readonly description: string;
  /** `@opentui/keymap` command name. Absent for prompt-local chords. */
  readonly command?: string;
  /** Binding strings for `command`. Absent for prompt-local chords. */
  readonly bindings?: readonly string[];
}

export const SHELL_SHORTCUTS: readonly ShellShortcut[] = [
  {
    keys: "Enter",
    description:
      "soft-steer at the next tool boundary while busy (held above the prompt); send straight through when idle",
  },
  {
    keys: "Alt+Enter",
    description:
      "queue a follow-up delivered only when the run goes idle; does nothing unless a run is busy",
    command: "shell.queue",
    bindings: ["alt+return"],
  },
  {
    keys: "Up / Down / Enter / Ctrl+X",
    description:
      "on held items above the prompt: select, send now, drop (Esc backs out)",
    // Up, Down, and Enter also move the caret, recall history, or send.
    // Only Ctrl+X is unambiguous; the others stay in keys.ts.
    command: "shell.held.drop",
    bindings: ["ctrl+x"],
  },
  {
    keys: "Ctrl+C",
    description:
      "pause a busy run and hold the queue, or clear the prompt and attachments when idle; Ctrl+C again to exit — with live sub-agents, a 2nd press stops them, a 3rd quits",
    command: "shell.interrupt",
    bindings: ["ctrl+c"],
  },
  {
    keys: "Ctrl+G",
    description:
      "pop the most recently queued or steered message back into the prompt for editing",
    command: "shell.cancel",
    bindings: ["ctrl+g"],
  },
  {
    keys: "Alt+C",
    description:
      "copy mode: pick a message, tool output, or diff; press again to close it",
    command: "shell.copy",
    bindings: ["alt+c"],
  },
  {
    keys: "Alt+M",
    description:
      "toggle DEC mouse capture (on by default: wheel scroll, click-to-expand, drag-to-copy); off restores native terminal drag-select",
    command: "shell.mouse",
    bindings: ["alt+m"],
  },
  {
    keys: "Alt+E",
    description:
      "expand or collapse every collapsible row (tool call, diff, skill, reasoning)",
    command: "shell.expand",
    bindings: ["alt+e"],
  },
  {
    keys: "Alt+T",
    description:
      "show or hide the task list above the prompt (hidden by default)",
    command: "shell.tasks",
    bindings: ["alt+t"],
  },
  {
    keys: "Alt+O",
    description:
      "observe a live subagent session; a system row says so when there is none",
    command: "shell.observe",
    bindings: ["alt+o"],
  },
  {
    keys: "Tab",
    description: "move focus between the prompt and the transcript",
    command: "shell.focus",
    bindings: ["tab"],
  },
  {
    keys: "Shift+Tab",
    description: "cycle reasoning effort for the current model",
    command: "shell.effort",
    bindings: ["shift+tab"],
  },
  {
    keys: "Esc",
    description: "close the open overlay, or leave subagent observe",
    command: "shell.dismiss",
    bindings: ["escape"],
  },
  {
    keys: "Ctrl+B / Ctrl+F",
    description: "move the cursor back / forward one character",
  },
  { keys: "Ctrl+D", description: "delete the character under the cursor" },
  {
    keys: "Alt+B / Alt+F",
    description: "move the cursor back / forward one word",
  },
  {
    keys: "Ctrl+K",
    description: "kill from the cursor to the end of the line",
  },
  {
    keys: "Ctrl+U",
    description: "kill from the start of the line to the cursor",
  },
  { keys: "Ctrl+W", description: "kill the previous word" },
  { keys: "Alt+D", description: "kill the next word" },
  { keys: "Ctrl+Y", description: "yank the last kill at the cursor" },
  {
    keys: "Alt+Y",
    description: "replace the text just yanked with the next-older kill",
  },
  {
    keys: "Ctrl+V / Ctrl+P",
    description: "attach a PNG from the macOS clipboard to the next message",
  },
  {
    keys: "@",
    description:
      "at the start of a word, open file suggestions for the @mention being typed",
  },
  {
    keys: "/",
    description:
      "at an empty prompt, open the command list (Tab completes, Enter runs); also lists /help",
  },
  {
    keys: "Up / Down",
    description:
      "recall previously sent messages, from the prompt's first / last row",
  },
  {
    keys: "Arrow keys",
    description: "move the cursor left / right / up / down in the prompt",
  },
  {
    keys: "Ctrl+Enter / Ctrl+J",
    description:
      "insert a newline instead of sending (Shift+Enter also works on terminals that report the modifier)",
  },
] as const;

/** Application chords the keymap registers. */
export function keymapShortcuts(): readonly ShellShortcut[] {
  return SHELL_SHORTCUTS.filter((row) => row.command !== undefined);
}

/**
 * Prompt-local rows: textarea defaults, the kill ring, paste, and chords
 * whose meaning depends on context the keymap does not own.
 */
export function promptLocalShortcuts(): readonly ShellShortcut[] {
  return SHELL_SHORTCUTS.filter((row) => row.command === undefined);
}

function formatShortcut(row: ShellShortcut): string {
  return `${row.keys} — ${row.description}`;
}

/**
 * Help rows from the keymap catalog plus prompt-local rows, in catalog
 * order, so the overlay cannot drift from either list.
 */
export function helpItems(): readonly string[] {
  const owned = new Set<string>([
    ...keymapShortcuts().map((row) => row.keys),
    ...promptLocalShortcuts().map((row) => row.keys),
  ]);
  return [
    ...SHELL_SHORTCUTS.filter((row) => owned.has(row.keys)).map(formatShortcut),
    "Close help",
  ];
}
