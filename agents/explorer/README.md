# @corbits/code-agent-explorer

## What this is

Ready `@corbits/code-agent-explorer` agent + independently importable components:
`agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config`. Explorer is
the read-only mapping & search worker: it maps the codebase against the brief and
reports scannable findings — it never implements, reviews, or discovers the fleet.

## Consume (runLocal)

```ts
import { agent } from "@corbits/code-agent-explorer";
const run = runLocal(defining(agent), env);
```

## Consume (deploy runWorkflow / hub / sidecar)

Hand the same `AgentDefinition` to a workflow — the package never exports a
workflow itself.

## Remix components

```ts
import { director, tools, systemPrompt, config } from "@corbits/code-agent-explorer";
defineAgent({ director, ... }); // or swap tools / systemPrompt / config
```

Each of `agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Single authority

`prompt.ts` `systemPrompt.build()` is byte-stable (the raw card, no formatting).
`toolset.ts` `tools` literal equals the `READ_TOOLS` surface constant in
`src/agent/directors/tool-sets.ts` (explorer is deliberately read-only — no
`write_file`/`edit_file`/`delete_file`); drift is enforced by the in-tree
drift-guard `src/agent/directors/explorer/package.test.ts`.
