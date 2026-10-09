# @corbits/code-agent-designer

## What this is

A ready-to-go Corbits agent for the **designer** role (`@corbits/code-agent-designer`)
plus its named component parts so a consumer can recreate or remix it. Designer is
the UI/UX design engineering specialist: it owns DESIGN.md creation and updates,
impeccable.style design laws, design tokens, typography, spatial layout, and
micro-interaction polish.

## Consume (runLocal)

```ts
import { agent } from "@corbits/code-agent-designer";
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
} from "@corbits/code-agent-designer";

// Swap components at the consumer side.
defineAgent({ director, tools, systemPrompt, config }); // or spread overrides
```

Each of `agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Byte-stability & single authority

- `systemPrompt.build()` is pure and byte-stable — identical string every call.
- `tools` is content-equal to the app's `REVIEW_TOOLS` surface constant
  (`src/agent/directors/tool-sets.ts`); the in-tree drift-guard
  (`src/agent/directors/designer/package.test.ts`) enforces they match.
- This package is the single prompt authority for designer; the in-tree
  `src/agent/directors/designer/package.ts` is deleted.
