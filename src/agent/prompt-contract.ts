// Deterministic substrings the chat system prompt must retain after edits.
// Used by src/prompts.test.ts as a lightweight regression harness (CL-3117).

export const CHAT_PROMPT_QUALITY_MARKERS = [
  "Match their tone",
  "Response style:",
  "Tool choice:",
  "Ask vs proceed:",
  "Scope and conventions:",
  "edit_file for targeted changes",
  "ask_operator only when permission blocks you",
  "Touch only code required for the task",
  "load the style and philosophy skills",
  "grep or search_files",
  "never echo, heredoc, sed, or rm in the shell",
] as const;