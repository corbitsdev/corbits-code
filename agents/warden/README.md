# @corbits/code-agent-warden

## What this is

A ready-to-go Corbits agent for the **warden** role (`@corbits/code-agent-warden`)
plus its named component parts so a consumer can recreate or remix it. Warden is
the trust-review worker: it reviews permission, provider-auth, and plugin-loader
diffs only, and never fixes product code.

## Consume (runLocal)

```ts
import { agent } from "@corbits/code-agent-warden";
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
} from "@corbits/code-agent-warden";

// Swap components at the consumer side.
defineAgent({ director, tools, systemPrompt, config }); // or spread overrides
```

Each of `agent`, `defineAgent`, `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Byte-stability & single authority

- `systemPrompt.build()` is pure and byte-stable — identical string every call.
- `tools` is the literal expansion of the app's `REVIEW_TOOLS` surface constant
  (`src/agent/directors/tool-sets.ts`); the in-tree drift-guard
  (`src/agent/directors/warden/package.test.ts`) enforces they match.
- This package is the single prompt authority for warden; the in-tree
  `src/agent/directors/warden/package.ts` is deleted.
