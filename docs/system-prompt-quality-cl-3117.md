# System prompt quality pass (CL-3117)

## Audit vs leading agents

Compared Intercode's pre-pass prompt (`src/agent/prompts.ts`) to publicly documented patterns from **OpenAI Codex** (`gpt_5_codex_prompt.md`, vendored in `src/auth/codex/prompts/gpt-5-codex.ts`), **Claude Code**-style harness docs (tool-first file ops, no destructive git), and **opencode**-style agent CLIs (concise default voice, explicit scope).

| Gap (before) | Leading-agent pattern | Change |
|---|---|---|
| One-line role | Tone matching + default brevity | Expanded `buildChatRole()` |
| Thin "Be concise" guidelines | Sections for style, tools, autonomy, scope | Rewrote `buildGuidelines()` into four blocks |
| Harness facts only for tool routing | Tool summaries reinforce read/grep/lsp vs shell | Sharpened `TOOL_SUMMARIES` for core file tools |
| No testable prompt contract | Pin required substrings | `prompt-contract.ts` + `prompts.test.ts` |
| Ask vs proceed only in harness facts | Repeated in guidelines with examples | `Ask vs proceed` block + `ask_operator` pairing |

Deliberately **not** copied: Codex-specific tools (`apply_patch`, `rg` preference) — Intercode blocks shell `rg`/`find` and uses `grep`/`search_files` instead.

## Validation

Deterministic regression (no live model):

```bash
bun test src/prompts.test.ts
```

`CHAT_PROMPT_QUALITY_MARKERS` in `src/agent/prompt-contract.ts` must all appear in `buildChatSystemPrompt()`. Extend that list when adding new prompt obligations.

Full LLM before/after on a fixed task set remains future work; this PR delivers the reviewable prompt rewrite plus substring harness required for CI.

## Rationale summary

- **Verbosity:** concise default, structure on demand — mirrors Codex "friendly teammate" without importing CLI formatting rules Intercode does not enforce.
- **Tool selection:** align model behavior with sandbox blocks (shell writes/search) and director tools (`delete_file`, `lsp`, `use_skill`).
- **Ask vs proceed:** narrow `ask_operator` to permission/ambiguity; autonomous on bounded coding tasks.
- **Scope:** encode AGENTS.md scope discipline and skill loading in the system prompt so models see it every turn.