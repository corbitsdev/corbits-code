# Scribe plugin

A `kind: "command"` plugin that contributes the `/scribe` slash command. It injects
the bundled **gaas:scribe** skill into the next agent turn (via `plugins/scribe/skills/scribe/SKILL.md`)
and sends a short user message describing what to document.

Enable the plugin in `/plugins`, then run `/scribe <topic>` in chat.

There is no separate scribe workflow in the runtime registry; documentation work is
skill-driven. The **build** workflow in `linear-workflows` references `gaas:scribe` on
its optional documentation step.