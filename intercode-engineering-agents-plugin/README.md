# Intercode Engineering Agents Plugin

1:1 mirror of [corbitsdev/examples — engineering-agent-team](https://github.com/corbitsdev/examples/tree/main/solutions/engineering-agent-team) for Intercode.

| Upstream | This plugin |
|----------|-------------|
| `agents/*.md` | `engineering-agents/agents/*.md` |
| `skills/*/SKILL.md` | `engineering-agents/skills/*/SKILL.md` |

**Agent-kind only** — adds spawnable `task` profiles. No slash commands.

## Install

1. **/plugins → add by path** → `…/intercode-engineering-agents-plugin/engineering-agents`
2. Enable **engineering-agents**.
3. Set tiers in **/model** (e.g. karen & greybeard → clever, critique & neckbeard → standard, intern → fast).

```json
{
  "pluginPaths": ["/path/to/intercode-engineering-agents-plugin/engineering-agents"],
  "plugins": { "engineering-agents": { "enabled": true } }
}
```

## Team (`task` + `agent`)

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