// Artist worker: visual asset specialist.
// Hand-crafts SVGs, visual diagrams (Mermaid, ASCII art), and structured
// generative graphic prompts for image generation models.

const ARTIST_TOOLS = [
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

export const tools: readonly string[] = [...ARTIST_TOOLS];
