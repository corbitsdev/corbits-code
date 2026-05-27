# Claude Workspace Instructions

This repository also supports Claude workspaces. Use this file for
Claude-specific startup context, and keep shared guidance in `AGENTS.md` or
`.agents/` when it should apply to every agent.

## Startup

1. Load the `style` skill.
2. Load the `philosophy` skill.
3. Read `AGENTS.md`.
4. Check `.agents/agents/` for shared project agent profiles.
5. Check `.agents/skills/` for shared project skills.
6. Check `.claude/skills/` for Claude-specific project skills.

Do not do anything else before completing the first three startup steps.

## Skill Locations

- Shared skills: `.agents/skills/`
- Shared agents: `.agents/agents/`
- Claude-specific skills: `.claude/skills/`
- Claude-specific agent adapters: `.claude/agents/`

Do not duplicate shared content between folders. Put shared behavior in
`.agents/` and add only Claude-specific adapters under `.claude/`.
