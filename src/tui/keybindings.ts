/**
 * Help rows. Application lines come from the live `@opentui/keymap`
 * registration (`bindAppHelp`). Widget-default rows are the Textarea chords
 * `defaultTextareaKeyBindings` / `PROMPT_KEY_BINDINGS` already perform, plus
 * the kill-ring yank chords the textarea does not implement.
 * There is no second copy of the application chord table here.
 */

export interface ShellShortcut {
  readonly keys: string;
  readonly description: string;
}

/**
 * Prompt-local rows. Cursor, delete, word motion, and newline/submit are
 * Textarea defaults (`renderables/Textarea.d.ts` `TextareaAction`). Yank is
 * not a Textarea action; it stays listed because the kill ring records it.
 */
export const WIDGET_DEFAULT_SHORTCUTS: readonly ShellShortcut[] = [
  {
    keys: "Enter",
    description:
      "soft-steer at the next tool boundary while busy (held above the prompt); send straight through when idle",
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
];

let appRows: readonly ShellShortcut[] = [];
let readAppHelp: () => readonly string[] = () =>
  appRows.map((row) => `${row.keys} — ${row.description}`);

/** Called when the keymap module loads, and again from the live keymap. */
export function setAppShortcutRows(rows: readonly ShellShortcut[]): void {
  appRows = rows;
}

export function bindAppHelp(read: () => readonly string[]): () => void {
  const previous = readAppHelp;
  readAppHelp = read;
  return () => {
    readAppHelp = previous;
  };
}

/** Catalog the live tests drive. Application rows are whatever the keymap registered. */
export function shellShortcuts(): readonly ShellShortcut[] {
  return [...appRows, ...WIDGET_DEFAULT_SHORTCUTS];
}

function formatShortcut(row: ShellShortcut): string {
  return `${row.keys} — ${row.description}`;
}

/** Keymap command lines, then widget-default rows. */
export function helpItems(): readonly string[] {
  return [
    ...readAppHelp(),
    ...WIDGET_DEFAULT_SHORTCUTS.map(formatShortcut),
    "Close help",
  ];
}
