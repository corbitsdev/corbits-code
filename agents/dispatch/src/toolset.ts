// Dispatch primary: orchestrator surface plus fleet discovery (Tier-1 only).
// Literal expansion of the `DISPATCH_TOOLS` constant in
// `src/agent/directors/tool-sets.ts` (the single tool authority). Drift is
// enforced by the in-tree `src/agent/directors/dispatch/package.test.ts`.
const DISPATCH_TOOLS = [
  "read_file",
  "grep",
  "search_files",
  "list_dir",
  "lsp",
  "run_shell",
  "web_fetch",
  "web_search",
  "skill_search",
  "use_skill",
  "write_file",
  "edit_file",
  "delete_file",
  "spawn_agent",
  "list_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "send_input",
  "read_agent_trace",
  "search_agents",
] as const;

/** The dispatch tool allowlist — literal equal to the in-tree `DISPATCH_TOOLS`. */
export const tools: readonly string[] = [...DISPATCH_TOOLS];
