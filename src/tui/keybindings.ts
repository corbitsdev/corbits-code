/**
 * OpenTUI shell keybinding catalog (pure data) — the help overlay's source
 * of truth. Every row must be a chord that really works: a handler in
 * `src/tui/shell.ts`, or a default prompt binding from @opentui/core. Do
 * not hand-transcribe from docs; `keybindings.test.ts` drives every row's
 * chord through a live shell and asserts its effect.
 */

export interface ShellShortcut {
  readonly keys: string;
  readonly description: string;
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
  },
  {
    keys: "Up / Down / Enter / Ctrl+X",
    description:
      "on held items above the prompt: select, send now, drop (Esc backs out)",
  },
  {
    keys: "Ctrl+C",
    description:
      "pause a busy run and hold the queue, or clear the prompt and attachments when idle; Ctrl+C again to exit — with live sub-agents, a 2nd press stops them, a 3rd quits",
  },
  {
    keys: "Ctrl+G",
    description:
      "pop the most recently queued or steered message back into the prompt for editing",
  },
  {
    keys: "Alt+C",
    description:
      "copy mode: pick a message, tool output, or diff; press again to close it",
  },
  {
    keys: "Alt+M",
    description:
      "toggle DEC mouse capture (on by default: wheel scroll, click-to-expand, drag-to-copy); off restores native terminal drag-select",
  },
  {
    keys: "Alt+E",
    description:
      "expand or collapse every collapsible row (tool call, diff, skill, reasoning)",
  },
  {
    keys: "Alt+T",
    description:
      "show or hide the task list above the prompt (hidden by default)",
  },
  {
    keys: "Alt+O",
    description:
      "observe a live subagent session; a system row says so when there is none",
  },
  {
    keys: "Tab",
    description: "move focus between the prompt and the transcript",
  },
  {
    keys: "Shift+Tab",
    description: "cycle reasoning effort for the current model",
  },
  {
    keys: "Esc",
    description: "close the open overlay, or leave subagent observe",
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

/** Help rows from the shell's own catalog, so they cannot drift from it. */
export function helpItems(): readonly string[] {
  return [
    ...SHELL_SHORTCUTS.map((s) => `${s.keys} — ${s.description}`),
    "Close help",
  ];
}
