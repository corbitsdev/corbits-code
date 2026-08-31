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
 * Path mutation tools shared by closed directors. Codex `apply_patch` stays on
 * build/docs only — review/explore/orchestrator/intern mount these path tools
 * alone (lane discipline lives in prompts, not the capability filter).
 */
export const PRODUCT_WRITE_TOOLS = ["write_file", "edit_file", "delete_file"] as const;

/**
 * Build: read + full file mutation. `shell` and `update_plan` are Codex
 * proxy names (createCodexToolProxies) for `run_shell` / the plan tool; both
 * are listed here so Codex build leaves keep the proxies after the
 * capability filter, same rationale as `apply_patch` below.
 */
export const BUILD_TOOLS = [
  ...READ_TOOLS,
  ...PRODUCT_WRITE_TOOLS,
  "apply_patch",
  "shell",
  "update_plan",
] as const;

/**
 * Docs leaves: read/search/lsp/web + file writes — no run_shell.
 * Envelope policy only: docs leaves omit shell so they cannot mutate via the
 * terminal. There is no separate path-level lock on top of the tool envelope.
 *
 * Composed from READ_TOOLS minus run_shell so it tracks the read surface
 * automatically; path writes come from PRODUCT_WRITE_TOOLS. `apply_patch` is
 * included so Codex docs leaves keep the proxy after the capability filter.
 * `update_plan` is included for the same reason (its proxy has no `run_shell`
 * dependency, so it is not excluded alongside `shell`).
 */
export const DOCS_TOOLS = [
  ...READ_TOOLS.filter((t) => t !== "run_shell"),
  ...PRODUCT_WRITE_TOOLS,
  "apply_patch",
  "update_plan",
] as const;

/** Review / counsel: read surface + path writes (lane discipline in prompts). */
export const REVIEW_TOOLS = [...READ_TOOLS, ...PRODUCT_WRITE_TOOLS] as const;

/** Mechanical intern: shell-first + path writes when the brief requires them. */
export const INTERN_TOOLS = ["run_shell", "read_file", "list_dir", ...PRODUCT_WRITE_TOOLS] as const;

/** Nested orchestrator surface (greybeard / package filter): dispatch + path writes. */
export const ORCHESTRATOR_TOOLS = [
  ...READ_TOOLS,
  ...PRODUCT_WRITE_TOOLS,
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "send_input",
  "read_agent_trace",
] as const;

/** Skywalker primary: orchestrator surface plus fleet discovery (Tier-1 only). */
export const SKYWALKER_TOOLS = [...ORCHESTRATOR_TOOLS, "search_agents"] as const;
