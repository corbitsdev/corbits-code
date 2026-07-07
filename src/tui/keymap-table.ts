export type ShortcutEntry = { keys: string; description: string };

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Ctrl+C", description: "Exit (with confirm)" },
  { keys: "Ctrl+H", description: "Toggle hooks panel" },
  { keys: "Ctrl+T", description: "Toggle task panel" },
  { keys: "Ctrl+O", description: "Toggle expand all tool output" },
  { keys: "Ctrl+R", description: "Expand/collapse last tool" },
  { keys: "Ctrl+P", description: "Toggle tasks full-screen" },
  { keys: "Ctrl+G", description: "Toggle this help overlay" },
  { keys: "Ctrl+Y", description: "Copy mode: pick a message, tool output, or diff (a = whole conversation)" },
  { keys: "Alt+← / Alt+→", description: "Move prompt cursor by word" },
  { keys: "Cmd+← / Cmd+→", description: "Move prompt cursor to line start/end" },
  { keys: "↑ / ↓", description: "Recall sent messages at prompt edges; scroll panes when empty" },
  { keys: "ESC", description: "Back / close overlay" },
  { keys: "ESC ESC", description: "Clear prompt" },
];

export const SLASH_COMMANDS: ShortcutEntry[] = [
  { keys: "/help", description: "Show the help overlay" },
  { keys: "/tasks", description: "Show the tasks panel" },
  { keys: "/agent", description: "Configure provider, model, tiers, and profiles" },
  { keys: "/permissions", description: "View and revoke remembered approvals" },
];
