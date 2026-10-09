const SHAKESPEARE_TOOLS = [
  "read_file",
  "grep",
  "search_files",
  "list_dir",
  "lsp",
  "web_fetch",
  "web_search",
  "skill_search",
  "use_skill",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

export const tools: readonly string[] = [...SHAKESPEARE_TOOLS];