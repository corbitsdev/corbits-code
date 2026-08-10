// Small, explicit tool allowlists for director packages.
// Prefer tools.allow at mount (CapabilityFilter include) over huge deny lists.
// manage_tasks is always mounted by runSubAgent after the filter — omit it here.
// use_skill / tool_search / ask_operator are primary-session tools: leaves do
// not mount them (skill guidance is baked into package system prompts).

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

/** Implement: read + full file mutation. */
export const IMPLEMENT_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "edit_file",
  "delete_file",
] as const;

/** Docs leaves that may write only under writePaths authz. */
export const DOCS_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "edit_file",
] as const;

/** Review / counsel: read surface, no writes. */
export const REVIEW_TOOLS = [...READ_TOOLS] as const;

/** Mechanical intern: shell-first, minimal surface. */
export const INTERN_TOOLS = ["run_shell", "read_file", "list_dir"] as const;

/** Nested orchestrator surface (greybeard / package filter): dispatch only. */
export const ORCHESTRATOR_TOOLS = [
  ...READ_TOOLS,
  "search_agents",
  "task",
] as const;
