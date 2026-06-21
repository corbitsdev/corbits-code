# Scribe plugin

A `kind: "command"` plugin that contributes the `/scribe` slash command — a
workflow-shaped port of the `gaas:scribe` skill. The skill is a system prompt
with a series of targets; this plugin turns each of its execution phases into a
discrete, auto-advancing step.

The workflow (`scribe`) lives in `@intercode/default-workflows`, which registers
it with the workflow runtime. This plugin owns the `/scribe` command and
dispatches to that workflow — the same relationship `linear-workflows` has to
the shared scope/build/review recipes.

## The workflow

`/scribe <input>` runs a seven-step flow that processes the input you hand it:

1. **Discover docs** — locate and read every doc-shaped file, classify each by
   abstraction level (PRODUCT / ARCHITECTURE / IMPLEMENTATION), and learn the
   project's vocabulary.
2. **Analyze input** — classify the user's input by abstraction level (a single
   input may span several).
3. **Classify and deepen** — decompose ambiguous input into distinct claims via
   `ask_operator`, with context-aware options (uses the `gaas:scribe` skill).
4. **Write documentation** — update the target doc(s), match existing style, and
   commit. Assesses whether the change is significant.
5. **Cross-document consistency** — for significant changes, check siblings and
   surface implied-but-missing entries via `ask_operator`.
6. **Detect gaps** — for significant changes, probe for failure modes, limits,
   and missing rationale via `ask_operator`.
7. **Report** — a brief summary of what changed.

No plan step, no approval gate — the only interaction is the inline
`ask_operator` tool for interviews and gap-filling.

## Enabling

Command plugins require explicit enable. Run `/plugins`, find **Scribe**, and
enable it. `/scribe` then appears in the command palette.
