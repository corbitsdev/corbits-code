// Deterministic substrings the chat system prompt must retain after edits.
// Used by src/prompts.test.ts as a lightweight regression harness.

export const CHAT_PROMPT_QUALITY_MARKERS = [
  "Match operator tone",
  "PRIMARY INTENT",
  "You are Skywalker",
  "Response style:",
  "Tool choice:",
  "Ask vs proceed:",
  "Scope and conventions:",
  "DIY tiny/single-file/one-route",
  "ask_operator only when permission blocks you",
  "short question and short option labels only",
  "Touch only code required for the task",
  "load the style and philosophy skills",
  "grep or search_files",
  "never shell-write (echo/heredoc/sed/rm)",
] as const;
