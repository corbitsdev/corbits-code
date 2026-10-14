# @corbits/code-agent-shakespeare

## What this is

Ready `@corbits/code-agent-shakespeare` agent + independently importable components:
`director`, `tools`, `systemPrompt`, `config`.

## Remix components

```ts
import {
  director,
  tools,
  systemPrompt,
  config,
} from "@corbits/code-agent-shakespeare";
// or swap tools / systemPrompt / config
```

Each of `director`, `tools`, `systemPrompt`, and `config` is a named,
independently importable part.

## Single authority

`prompt.ts` `systemPrompt.build()` is byte-stable (the raw card, no formatting).
`toolset.ts` `tools` re-exports the `DOCS_TOOLS` surface constant in
`src/agent/directors/tool-sets.ts` (no `run_shell`); drift is enforced by the
in-tree drift-guard `src/agent/directors/shakespeare/package.test.ts`.
