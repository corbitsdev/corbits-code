---
name: create-issue
description: Create well-structured issues. Linear MCP if available; otherwise ask for GitHub (or another tracker) and remember the preference.
argument-hint: "[description] [--from-doc]"
---

# Create Issue

How to create well-structured issues (and, on Linear, projects / project updates / initiatives when the operator asks). Tracker selection first, then quality phases, then create.

Clarifying questions use `ask_operator`. Do not invent Claude-only tools. Do not invent a Linear REST client. Do not restate MCP tool names or schemas — use the mounted Linear MCP tools as they appear in the toolset.

## Tracker selection

Pick the tracker before drafting. Do not skip this.

1. If `mcp__linear__*` tools are available → **Linear**. Do not ask.
2. Else `read_file` `.corbits/MEMORY.md` for `Preferred issue tracker:`. If present, use that tracker.
3. Else `ask_operator` with options: GitHub / GitLab / Linear (enable MCP) / Other. Persist the choice: append `Preferred issue tracker: <name>` to `.corbits/MEMORY.md` only (write_file/edit_file — path tools are the DIY surface; shell writes stay denied).
4. **GitHub** → `gh issue create` (title + body) via `run_shell`. If `gh` is missing, tell the operator to install GitHub CLI and stop. Do not invent an HTTP client.
5. **GitLab** → `glab issue create` (title + body) via `run_shell`. If `glab` is missing, tell the operator and stop.
6. **Linear without MCP** → stop. Tell the operator to enable Linear MCP. Do not invent a Linear REST client.
7. **Other** → `ask_operator` how they file issues, then follow that.

## Phase 1: Document discovery

When the operator passes `--from-doc` or names a planning document, `search_files` / `read_file` for `PRODUCT.md`, `ARCHITECTURE.md`, `IMPLEMENTATION.md` at the repo root and under `docs/`. If none exist, `ask_operator` whether they have a document to reference. Extract features, constraints, and scope signals — use them to pre-populate drafts and ask only for gaps.

## Phase 2: Scope

Determine the artifact:

1. **Explicit** — operator names issue / project / initiative / project update
2. **From document** — `--from-doc`
3. **Freeform** — estimate scope and confirm with `ask_operator`

| Scope  | Duration  | Artifact                                                              |
| ------ | --------- | --------------------------------------------------------------------- |
| Small  | 1-3 days  | Single issue                                                          |
| Medium | 1-2 weeks | Project with issues (Linear) or a set of issues (GitHub / GitLab)     |
| Large  | Quarter+  | Initiative with projects (Linear) or grouped issues (GitHub / GitLab) |

Project updates are never inferred from scope — the operator must ask for one. Skip project / initiative / update artifacts on GitHub and GitLab unless the operator wants an issue-shaped stand-in.

## Phase 3: Interview

Ask only for missing required info. Keep it brief.

**Issues** — problem/value; acceptance criteria. Optional: constraints, owning team.

**Projects (Linear)** — goal/outcome; timeframe; lead. Optional: teams, milestones.

**Initiatives (Linear)** — strategic objective; executive owner; projects to include.

**Project updates (Linear)** — which project; health (on track / at risk / off track / completed / paused); what unlocked since last update (capabilities, not ticket lists); what's next by user-visible impact; risks by outcome impact. Retrieve the most recent prior update before drafting so the new one continues the narrative.

## Phase 4: Draft

### No local file paths

Tracker readers do not share your working directory. No local paths, line numbers, or "see `src/foo.ts`". Describe behavior in plain language, link permanent URLs, or quote a short excerpt. Specs that must travel attach to the Linear issue or project — never point at a local path. On GitHub / GitLab, paste meaning into the body or link a permanent URL.

### Issue format

**Title**: actionable. Prefer verb phrases.

- Good: "Add retry logic for failed API calls"
- Bad: "API retry"

**Description**:

```
# Background

<Context. Optional for simple tasks.>

# Outcome

- [ ] <Specific, testable condition>
- [ ] <Another condition>
```

Simple tasks may omit `# Background`. Use `# Outcome` subsections when it helps. Set priority and labels when the workspace uses them; `ask_operator` if unspecified.

### Project (Linear)

Outcome-focused name. Description: goal, scope, constraints. Validation projects may use Hypothesis / Experiment / Steps. Milestones mark progression.

### Initiative (Linear)

Strategic objective name. Description covers the business goal and how success is measured.

### Project update (Linear)

Audience is non-technical. Lead with what is now possible. No completed-ticket laundry lists, jargon, or implementation detail. Short structure:

```
## Where we are
## What this unlocks
## What's next
## Risks
```

Omit empty sections. Set health to match reality (`onTrack`, `atRisk`, `offTrack`, `complete`, `paused`). Self-check: would a non-engineer know what changed for them?

## Phase 5: Review

Present the full draft and `ask_operator` whether to adjust before creating. Allow title/description edits, structure changes, add/remove items, assignees/teams.

## Phase 6: Create

### Linear

Discover workspace context (teams, and projects/initiatives when linking) with the mounted Linear MCP tools, then `ask_operator` when multiple choices exist. After approval: create containers first, then issues in dependency order (status **Todo** unless the operator says otherwise), then relationships / project / initiative links, then project updates. Report URLs. Do not invent a Linear REST client.

### GitHub

```bash
gh issue create --title "<title>" --body "<body>"
```

Report URLs. Missing `gh` → tell the operator and stop.

### GitLab

```bash
glab issue create --title "<title>" --description "<body>"
```

Report URLs. Missing `glab` → tell the operator and stop.

### Linear without MCP / Other

Stop for Linear-without-MCP (enable MCP). For Other, follow the operator's filing recipe.

## Errors

On failure: report the error, list what already succeeded (with URLs), do not create dependents if a parent failed, ask retry vs adjust.

## Quality

- Self-contained and handoff-ready
- One issue ≤ 2–3 days; split larger work
- Tickets are cheap — prefer clarity over consolidation
