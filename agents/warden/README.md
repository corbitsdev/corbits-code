# @corbits/code-agent-warden

## What this is

A ready-to-go Corbits agent for the **warden** role (`@corbits/code-agent-warden`)
plus its named component parts so a consumer can recreate or remix it. Warden is
the trust-review worker: it reviews permission, provider-auth, and plugin-loader
diffs only, and never fixes product code.

## Remix components

```ts
import {
  director,
  tools,
  systemPrompt,
  config,
} from "@corbits/code-agent-warden";

// Swap components at the consumer side.
```

Each of `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Byte-stability & single authority

- `systemPrompt.build()` is pure and byte-stable — identical string every call.
- `tools` is the literal expansion of the app's `REVIEW_TOOLS` surface constant
  (`src/agent/directors/tool-sets.ts`); the in-tree drift-guard
  (`src/agent/directors/warden/package.test.ts`) enforces they match.
- This package is the single prompt authority for warden; the in-tree
  `src/agent/directors/warden/package.ts` is deleted.
