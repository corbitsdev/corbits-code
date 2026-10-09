// Warden trust-review: review surface (read + product writes) — REVIEW_TOOLS.
// Literal expansion of the `REVIEW_TOOLS` constant in
// `src/agent/directors/tool-sets.ts` (the single tool authority). Drift is
// enforced by the in-tree `src/agent/directors/warden/package.test.ts`.
const REVIEW_TOOLS = [
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
] as const;

/** The warden tool allowlist — literal equal to the in-tree `REVIEW_TOOLS`. */
export const tools: readonly string[] = [...REVIEW_TOOLS];
