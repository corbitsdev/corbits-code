// Small, explicit tool allowlists for director packages.
// Prefer tools.allow at mount (CapabilityFilter include) over huge deny lists.
// manage_tasks, use_skill, and tool_search are harness tools mounted by
// runSubAgent after the filter — omit them here. ask_operator stays primary-only.

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

/**
 * Docs leaves: read/search/lsp/web + file writes — no run_shell, no delete_file.
 * Envelope policy, not a writePaths lock: docs leaves omit shell so they cannot
 * mutate via the terminal. Optional package writePaths, when a profile sets it,
 * is still enforced by the permission gate on path-keyed write tools.
 *
 * Composed from READ_TOOLS minus run_shell so it tracks the read surface
 * automatically; only the write tools are added explicitly.
 */
export const DOCS_TOOLS = [
  ...READ_TOOLS.filter((t) => t !== "run_shell"),
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

/** Primary Skywalker: implement surface plus dispatch. */
export const SKYWALKER_TOOLS = [
  ...IMPLEMENT_TOOLS,
  "search_agents",
  "task",
] as const;
