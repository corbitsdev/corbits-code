import { GPT_5_CODEX_PROMPT } from "./prompts/gpt-5-codex.js";

// The Codex backend (chatgpt.com/backend-api/codex/responses) validates the
// `instructions` field and rejects anything other than the official Codex
// system prompt for the requested model family with HTTP 400
// "Instructions are not valid". The app's own system prompt cannot go here; it
// rides in a leading developer message instead (see the adapter). We bundle the
// verbatim upstream prompt and serve it by model family.
//
// Source: github.com/openai/codex codex-rs/core/gpt_5_codex_prompt.md (MIT,
// retrieved from release rust-v0.139.0).

type CodexModelFamily = "codex" | "gpt-5";

function modelFamily(model: string): CodexModelFamily {
  return model.includes("codex") ? "codex" : "gpt-5";
}

// Only the codex-family prompt is bundled; gpt-5 falls back to it until a
// distinct gpt-5 prompt is bundled. The OAuth default model is gpt-5-codex.
const BUNDLED_INSTRUCTIONS: Record<CodexModelFamily, string> = {
  codex: GPT_5_CODEX_PROMPT,
  "gpt-5": GPT_5_CODEX_PROMPT,
};

export function getCodexInstructions(model: string): string {
  return BUNDLED_INSTRUCTIONS[modelFamily(model)];
}
