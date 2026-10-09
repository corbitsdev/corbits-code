# @corbits/code-agent-dispatch

## What this is

A ready-to-go Corbits agent for the **dispatch** role (`@corbits/code-agent-dispatch`)
plus its named component parts so a consumer can recreate or remix it. Dispatch is
the Tier-1 primary orchestrator: it classifies work, DIYs obvious mechanical
corrections, and spawns named specialists.

## Consume (runLocal)

```ts
import { agent } from "@corbits/code-agent-dispatch";
const run = runLocal(defining(agent), env);
```

## Consume (deploy runWorkflow / hub / sidecar)

Hand the same `AgentDefinition` (`agent`) to a workflow, hub, or sidecar. The
package never exports a workflow itself — a workflow _consumes_ `agent`.

## Remix components

```ts
import {
  director,
  tools,
  systemPrompt,
  config,
  defineAgent,
} from "@corbits/code-agent-dispatch";

// Swap components at the consumer side.
defineAgent({ director, tools, systemPrompt, config }); // or spread overrides
```

Each of `agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Byte-stability & single authority

- `systemPrompt.build()` is pure and byte-stable — identical string every call.
- `tools` is the literal expansion of the app's `DISPATCH_TOOLS` surface constant
  (`src/agent/directors/tool-sets.ts`); the in-tree drift-guard
  (`src/agent/directors/dispatch/package.test.ts`) enforces they match.
- This package is the single prompt authority for dispatch; the in-tree
  `src/agent/directors/dispatch/package.ts` (and the duplicate
  `createDispatchSystemPrompt` / `DISPATCH_CARD` in `src/agent/prompts.ts`) are deleted.
