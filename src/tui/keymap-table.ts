export type ShortcutEntry = { keys: string; description: string };

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Ctrl+C", description: "Exit (with confirm)" },
  { keys: "Ctrl+H", description: "Toggle hooks panel" },
  { keys: "Ctrl+T", description: "Toggle thinking output" },
  { keys: "Ctrl+R", description: "Expand last tool result" },
  { keys: "Ctrl+O", description: "Expand/collapse last tool" },
  { keys: "Ctrl+P", description: "Toggle plan full-screen" },
  { keys: "Ctrl+D", description: "Toggle diff full-screen" },
  { keys: "Ctrl+G", description: "Toggle this help overlay" },
  { keys: "↑ / ↓", description: "Scroll active pane when prompt is empty" },
  { keys: "ESC", description: "Back / close overlay" },
  { keys: "ESC ESC", description: "Clear prompt" },
];

export const SLASH_COMMANDS: ShortcutEntry[] = [
  { keys: "/help", description: "Show the help overlay" },
  { keys: "/diff", description: "Show the working-tree diff" },
  { keys: "/plan", description: "Show the plan panel" },
  { keys: "/agent", description: "Configure provider and model" },
  { keys: "/permissions", description: "View and revoke remembered approvals" },
  { keys: "/verbose", description: "Toggle full tool output" },
];
