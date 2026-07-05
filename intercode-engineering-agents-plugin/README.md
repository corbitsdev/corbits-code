# Intercode Engineering Agents Plugin

Data-only mirror of [corbitsdev/examples — engineering-agent-team](https://github.com/corbitsdev/examples/tree/main/solutions/engineering-agent-team) for Intercode.

No JavaScript. The plugin is a directory of agent markdown files plus the skills they reference. Intercode's plugin loader recognizes the layout and synthesizes the agent profiles at load time.

| Upstream | This plugin |
|----------|-------------|
| `agents/*.md` | `engineering-agents/agents/*.md` |
| `skills/*/SKILL.md` | `engineering-agents/skills/*/SKILL.md` |

**Agent-kind only** — adds spawnable `task` profiles. No slash commands.

## Install

1. **/plugins → add by path** → `…/intercode-engineering-agents-plugin/engineering-agents`
2. Enable **engineering-agents**.
3. Set tiers in **/model** (karen & greybeard → clever, critique & neckbeard → standard, intern → fast). Tiers are also declared in each agent's frontmatter, so this step is only needed to bind tiers to concrete provider/model assignments.

```json
{
  "pluginPaths": ["/path/to/intercode-engineering-agents-plugin/engineering-agents"],
  "plugins": { "engineering-agents": { "enabled": true } }
}
```

## Frontmatter

Each agent's YAML frontmatter uses keys any of the major agent dialects (Claude Code, OpenCode, corbitsdev) recognize. Intercode-native keys (`tier`, `capabilities`, `skills`, `inference`) win when both are present:

```yaml
---
name: neckbeard
description: Pedantic reviewer ...
mode: subagent          # upstream — informational in Intercode
tier: standard          # Intercode tier alias
skills: [style, philosophy]   # optional — also auto-detected from body
capabilities:           # Intercode-native tool filter
  mode: allow
  tools: [read_file, search_files, grep, list_dir]
permission:             # upstream dialect — also accepted
  bash: deny
  write: deny
---
```

For per-agent model pinning (instead of a tier alias), use `inference`:

```yaml
inference:
  mode: prefer              # pin = hard fail if unavailable; prefer = fall back
  order:
    - { provider: anthropic, model: claude-sonnet-4, reasoningEffort: medium }
    - { provider: xai,       model: grok-4 }
```

When no leg is viable, the `agentModelFallback` setting (`"active"` by default) decides whether to fall back to the user's currently active provider/model or fail loudly.

## Team

| `agent` | Upstream mode | Bundled skills |
|---------|---------------|----------------|
| `karen` | primary → **task sub-agent** in Intercode | dispatch, interview |
| `greybeard` | subagent | style, philosophy |
| `critique` | subagent | style, philosophy |
| `intern` | subagent | — |
| `neckbeard` | subagent (read-only) | style, philosophy |

The **Intercode** session you chat with calls `task`; sub-agents cannot nest `task`.

## Refresh from upstream

```bash
chmod +x scripts/sync-from-upstream.sh
./scripts/sync-from-upstream.sh
```

The sync script pulls the upstream `agents/*.md` and `skills/*/SKILL.md` files verbatim. Re-apply the Intercode-specific frontmatter keys (`tier`, `skills`, `capabilities`) afterward — they are the only deltas from upstream.
