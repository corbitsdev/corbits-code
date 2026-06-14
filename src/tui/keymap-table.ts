export type ShortcutEntry = { keys: string; description: string };

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Ctrl+C", description: "Exit (with confirm)" },
  { keys: "Ctrl+H", description: "Toggle hooks panel" },
  { keys: "Ctrl+T", description: "Toggle thinking output" },
  { keys: "Ctrl+O", description: "Toggle expand all tool output" },
  { keys: "Ctrl+R", description: "Expand/collapse last tool" },
  { keys: "Ctrl+P", description: "Toggle plan full-screen" },
  { keys: "Ctrl+D", description: "Toggle diff full-screen" },
  { keys: "Ctrl+W", description: "Toggle workflow steps panel (c for capabilities)" },
  { keys: "Ctrl+G", description: "Toggle this help overlay" },
  { keys: "Ctrl+Y", description: "Copy last output to clipboard" },
  { keys: "↑ / ↓", description: "Scroll active pane when prompt is empty" },
  { keys: "ESC", description: "Back / close overlay" },
  { keys: "ESC ESC", description: "Clear prompt" },
];

export const SLASH_COMMANDS: ShortcutEntry[] = [
  { keys: "/help", description: "Show the help overlay" },
  { keys: "/diff", description: "Show the working-tree diff" },
  { keys: "/plan", description: "Show the plan panel" },
  { keys: "/workflows", description: "Pick and start a coding workflow" },
  { keys: "/agent", description: "Configure provider, model, tiers, and profiles" },
  { keys: "/permissions", description: "View and revoke remembered approvals" },
  { keys: "/auto", description: "Toggle auto-approve for writes/edits and safe shell" },
  { keys: "/verbose", description: "Toggle full tool output" },
];
