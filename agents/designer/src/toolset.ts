// BUILD_TOOLS literal (= REVIEW_TOOLS); drift-guarded against REVIEW_TOOLS in
// src/agent/directors/tool-sets.ts.
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

export const tools: readonly string[] = [...BUILD_TOOLS];
