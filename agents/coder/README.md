# @corbits/code-agent-coder

## What this is

Ready `@corbits/code-agent-coder` agent + independently importable components:
`agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config`. Coder is
the implementation specialist: minimal safe diffs, root-cause fixes at the proper
layer, zero unnecessary abstractions, tests landed with changes, repo check gate.

## Consume (runLocal)

```ts
import { agent } from "@corbits/code-agent-coder";
const run = runLocal(defining(agent), env);
```

## Consume (deploy runWorkflow / hub / sidecar)

Hand the same `AgentDefinition` to a workflow — the package never exports a
workflow itself.

## Remix components

```ts
import { director, tools, systemPrompt, config } from "@corbits/code-agent-coder";
defineAgent({ director, ... }); // or swap tools / systemPrompt / config
```

Each of `agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Single authority

`prompt.ts` `systemPrompt.build()` is byte-stable (the raw card, no formatting).
`toolset.ts` `tools` literal equals the `BUILD_TOOLS` surface constant in
`src/agent/directors/tool-sets.ts`; drift is enforced by the in-tree drift-guard
`src/agent/directors/coder/package.test.ts`.
