# Client Template

This repository is the starting point for new client projects. It gives each
project a consistent agent workspace so Codex, Claude, and other agent tools can
share the same instructions, skills, and specialist agent profiles from day one.

The template does not include an application framework yet. Add the actual app,
site, or service stack after creating a new client repository from this base.

## How To Use This Template

1. Create a new repository from this template.
2. Add the client project's application code.
3. Update `AGENTS.md` with any project-specific rules.
4. Add reusable skills or agent profiles under `.agents/`.
5. Add runtime-specific adapters only when Claude or Codex needs different
   behavior.

## What's Included

- Shared startup instructions in `AGENTS.md`
- Claude-specific workspace notes in `CLAUDE.md`
- Shared agent profiles in `.agents/agents/`
- Shared skills in `.agents/skills/`
- Claude adapters in `.claude/`
- Codex adapters in `.codex/`

## Agent Roster

The shared profiles include:

- `bruckheimer` for turning early product ideas into clear briefs
- `karen` for project orchestration and dispatch planning
- `greybeard` for senior architecture and planning review
- `critique` for code review and test-backed quality checks
- `draper` for Corbits brand review
- `emil` for UI and design engineering critique
- `intern` for mechanical execution tasks
- `linear` for Linear issue work
- `neckbeard` for intentionally pedantic read-only reviews

## Shared Skills

The template includes these shared skills:

- `brand-identity`
- `design-lab`
- `dispatch`
- `interview`
- `philosophy`
- `scribe`
- `style`

Claude and Codex skill folders link back to the shared versions so updates stay
in one place.

## Conventions

- Keep shared behavior in `.agents/` whenever possible.
- Keep Claude-specific behavior in `.claude/`.
- Keep Codex-specific behavior in `.codex/`.
- Codex agent adapters should be `.toml` files.
- Commit changes as you go and push after committing.
