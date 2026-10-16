# @corbits/code-agent-coder

## What this is

Ready `@corbits/code-agent-coder` agent + independently importable components:
`director`, `tools`, `systemPrompt`, `config`. Coder is
the implementation specialist: minimal safe diffs, root-cause fixes at the proper
layer, zero unnecessary abstractions, tests landed with changes, repo check gate.

## Remix components

```ts
import {
  director,
  tools,
  systemPrompt,
  config,
} from "@corbits/code-agent-coder";
// or swap tools / systemPrompt / config
```

Each of `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Single authority

`prompt.ts` `systemPrompt.build()` is byte-stable (the raw card, no formatting).
`toolset.ts` `tools` re-exports the `BUILD_TOOLS` surface constant in
`src/agent/directors/tool-sets.ts`; drift is enforced by the in-tree drift-guard
`src/agent/directors/coder/package.test.ts`.
