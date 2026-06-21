# Example Agent Plugin

A minimal worked example of a `kind: "agent"` plugin. It contributes one
sub-agent profile, `scout`, that can be dispatched via the `task` tool with
`agent: "scout"`.

## What it shows

- The `manifest` export with `kind: "agent"`.
- The `agentPlugin` export containing `AgentProfile[]`.
- Read-only capability restriction (`mode: "allow"`, specific tools only).
- Tier assignment (`"fast"`) resolved via `settings.tiers` to a concrete
  provider and model at dispatch time.

## Usage

1. Enable in `/plugins` (or add this directory via "add by path").
2. In any session, the `task` tool accepts `agent: "scout"` to dispatch a
   sub-agent using this profile.
