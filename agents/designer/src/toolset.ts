// BUILD_TOOLS literal (= REVIEW_TOOLS); drift-guarded against REVIEW_TOOLS
// by src/agent/directors/designer/package.test.ts.
export const tools = [
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
