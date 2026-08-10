// Small, explicit tool allowlists for director packages.
// Prefer tools.allow at mount (CapabilityFilter include) over huge deny lists.
// manage_tasks is always mounted by runSubAgent after the filter — omit it here.

/** Read/search/shell — no product mutation. */
export const READ_TOOLS = [
  "read_file",
  "grep",
  "search_files",
  "list_dir",
  "lsp",
  "run_shell",
  "web_fetch",
  "web_search",
] as const;

/** Implement: read + full file mutation + skills. */
export const IMPLEMENT_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "edit_file",
  "delete_file",
  "use_skill",
] as const;

/** Docs leaves that may write only under writePaths authz. */
export const DOCS_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "edit_file",
  "use_skill",
] as const;

/** Review / counsel: read + skills, no writes. */
export const REVIEW_TOOLS = [...READ_TOOLS, "use_skill"] as const;

/** Mechanical intern: shell-first, minimal surface. */
export const INTERN_TOOLS = ["run_shell", "read_file", "list_dir"] as const;

/** Orchestrator (Skywalker / greybeard spawn path): dispatch, no product writes. */
export const ORCHESTRATOR_TOOLS = [
  ...READ_TOOLS,
  "use_skill",
  "tool_search",
  "search_agents",
  "task",
  "ask_operator",
] as const;
