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

/**
 * Implement: read + full file mutation. `shell` and `update_plan` are Codex
 * proxy names (createCodexToolProxies) for `run_shell` / the plan tool; both
 * are listed here so Codex implement leaves keep the proxies after the
 * capability filter, same rationale as `apply_patch` below.
 */
export const IMPLEMENT_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "edit_file",
  "delete_file",
  "apply_patch",
  "shell",
  "update_plan",
] as const;

/**
 * Docs leaves: read/search/lsp/web + file writes — no run_shell, no delete_file.
 * Envelope policy, not a writePaths lock: docs leaves omit shell so they cannot
 * mutate via the terminal. Optional package writePaths, when a profile sets it,
 * is still enforced by the permission gate on path-keyed write tools.
 *
 * Composed from READ_TOOLS minus run_shell so it tracks the read surface
 * automatically; only the write tools are added explicitly. `apply_patch` is
 * included so Codex docs leaves keep the proxy after the capability filter.
 * `update_plan` is included for the same reason (its proxy has no `run_shell`
 * dependency, so it is not excluded alongside `shell`).
 */
export const DOCS_TOOLS = [
  ...READ_TOOLS.filter((t) => t !== "run_shell"),
  "write_file",
  "edit_file",
  "apply_patch",
  "update_plan",
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
