// Explorer read surface only: literal expansion of the `READ_TOOLS` constant in
// src/agent/directors/tool-sets.ts (the single tool authority). Drift is enforced
// in-tree by src/agent/directors/explorer/package.test.ts.
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
] as const;
