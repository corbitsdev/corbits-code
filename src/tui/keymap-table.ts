export type ShortcutEntry = { keys: string; description: string };

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Ctrl+C", description: "Exit (with confirm)" },
  { keys: "Ctrl+H", description: "Toggle hooks panel" },
  { keys: "Ctrl+T", description: "Toggle thinking output" },
  { keys: "Ctrl+R", description: "Expand last tool result" },
  { keys: "Ctrl+D", description: "Cycle sidebar (plan / diff / off)" },
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
  { keys: "/verbose", description: "Toggle full tool output" },
];
