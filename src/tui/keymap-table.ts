export type ShortcutEntry = { keys: string; description: string };

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Ctrl+C", description: "Exit (with confirm)" },
  { keys: "Ctrl+H", description: "Toggle hooks panel" },
  { keys: "Ctrl+T", description: "Toggle task panel" },
  { keys: "Ctrl+O", description: "Toggle expand tool output (visible area)" },
  { keys: "Ctrl+R", description: "Expand/collapse last tool" },
  { keys: "Ctrl+P", description: "Toggle tasks full-screen" },
  { keys: "Ctrl+G", description: "Toggle this help overlay" },
  { keys: "Alt+C", description: "Copy mode: pick a message, tool output, or diff (a = whole conversation)" },
  { keys: "Ctrl+E", description: "Agents strip: pick a sub-agent session to enter (observe)" },
  { keys: "SHIFT+TAB", description: "Toggle auto mode (constrained permission envelope)" },
  { keys: "Alt+← / Alt+→", description: "Move prompt cursor by word" },
  { keys: "Cmd+← / Cmd+→", description: "Move prompt cursor to line start/end" },
  { keys: "Ctrl+B / Ctrl+F", description: "Move prompt cursor by character" },
  { keys: "Ctrl+D", description: "Delete character at cursor" },
  { keys: "Ctrl+K / Ctrl+U", description: "Kill to line end / line start" },
  { keys: "Ctrl+W / Alt+D", description: "Kill word backward / forward (Alt+Backspace = backward)" },
  { keys: "Ctrl+Y / Alt+Y", description: "Yank last kill / cycle earlier kills" },
  { keys: "↑ / ↓", description: "Recall sent messages at prompt edges; scroll panes when empty" },
  { keys: "ESC", description: "Back / close overlay / leave sub-agent session" },
  { keys: "ESC ESC", description: "Clear prompt" },
];

export const SLASH_COMMANDS: ShortcutEntry[] = [
  { keys: "/help", description: "Show the help overlay" },
  { keys: "/tasks", description: "Show the tasks panel" },
  { keys: "/model", description: "Connect providers, pick model, tiers, profiles" },
  { keys: "/permissions", description: "View and revoke remembered approvals" },
];
