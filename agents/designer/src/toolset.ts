// Designer UI/UX: build surface (read + product writes) — content-equal to the
// `REVIEW_TOOLS` constant in `src/agent/directors/tool-sets.ts` (the single
// tool authority; BUILD_TOOLS = REVIEW_TOOLS = READ_TOOLS + PRODUCT_WRITE_TOOLS).
// Drift is enforced by the in-tree `src/agent/directors/designer/package.test.ts`
// against `REVIEW_TOOLS`.
const BUILD_TOOLS = [
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

/** The designer tool allowlist — literal equal to the in-tree review/build surface. */
export const tools: readonly string[] = [...BUILD_TOOLS];
