---
name: lexicon
description: Diff director prompts against the agents repo at a pinned commit, report assembled prompt sizes, and file Linear issues for drift
argument-hint: "[--pin <commit>] [--file-issues]"
---

# Lexicon

Own prompt drift and size for the director prompts mirrored from the
agents repo. Diff each same-name director prompt against the agents
checkout at a pinned commit, report assembled prompt sizes, and file
Linear issues for drift.

## What this is not

- Not a director. There is no `lexicon` director package, no
  `src/agent/directors/lexicon/` module, and no Skywalker
  classification route. Never call `spawn_agent(agent="lexicon")` —
  this skill runs as a `/lexicon` slash playbook on the primary only.
- Not a fleet router. It does not assign identity or dispatch workers.
- Not ponytail. That skill stays untouched.

## Step 1: Pin the agents commit

All comparisons in one run use a single pinned commit of the agents
checkout — never float mid-run.

1. Resolve the checkout (default `/Users/thegreataxios/abklabs/agents`;
   accept an operator override path).
2. Record the pin: `git -C <checkout> rev-parse HEAD`.
3. Read every agents-side file with `git show <pin>:<path>` so local
   working-tree edits cannot skew the diff.

## Step 2: Match same-name prompts

- Director side: the closed `DIRECTOR_IDS` set in
  `src/agent/directors/types.ts`; each prompt lives in
  `src/agent/directors/<id>/package.ts` as `systemPrompt`.
- Agents side: `plugins/*/agents/*.md` files in the checkout, matched
  by file basename — `<id>.md` matches director `<id>` exactly.
- Near-misses are not diffs: `critique.md` is not `critic`, and
  `marketing-intern.md` is not `intern`. List them as unmatched, do
  not force a comparison.

## Step 3: Diff same-name pairs

For each matched pair, compare the director `systemPrompt` against the
agents file body at the pin. Report per director: in sync, or drifted
with the drifted sections quoted on both sides. Note the ported-from
commit recorded in the package comment (e.g. gaasbot's `@ 6e16b6c`)
when it disagrees with the pin — a stale port marker is itself drift.

## Step 4: Report assembled prompt sizes

Reuse the canonical helper in `src/agent/prompt-sizes.ts` — do not
hand-roll a new measurement:

- `directorPromptSizeTable()` for the full per-director x per-family
  table (default assembly vs Grok, pinned env).
- `formatPromptSizeTable(rows)` to render it as markdown.

Include the rendered table in the report. Sizes move only when real
prompt changes land; the env and provider inputs stay pinned.

## Step 5: File Linear issues for drift

Follow the `linear-issue-workflow` skill conventions. File one issue
per drifted director (never one mega-issue across directors), using
the mounted Linear MCP tools as they appear in the toolset — do not
invent a Linear REST client. Each issue carries the pinned agents
commit, the quoted drift from Step 3, and the size-table row from
Step 4. Without `--file-issues`, report the drift and stop — do not
file. Without mounted Linear MCP tools, stop and tell the operator
to enable Linear MCP.

## Report

Per director: match status (matched / unmatched with reason), sync
status at the pin, size rows, and the filed issue id or why nothing
was filed.
