# @corbits/code-agent-explorer

## What this is

Ready `@corbits/code-agent-explorer` agent + independently importable components:
`director`, `tools`, `systemPrompt`, `config`. Explorer is
the read-only mapping & search worker: it maps the codebase against the brief and
reports scannable findings — it never implements, reviews, or discovers the fleet.

## Remix components

```ts
import {
  director,
  tools,
  systemPrompt,
  config,
} from "@corbits/code-agent-explorer";
// or swap tools / systemPrompt / config
```

Each of `director`, `tools`, `systemPrompt`, `config` is a
named, independently importable part.

## Single authority

`prompt.ts` `systemPrompt.build()` is byte-stable (the raw card, no formatting).
`toolset.ts` `tools` re-exports the `READ_TOOLS` surface constant in
`src/agent/directors/tool-sets.ts` (explorer is deliberately read-only — no
`write_file`/`edit_file`/`delete_file`); drift is enforced by the in-tree
drift-guard `src/agent/directors/explorer/package.test.ts`.
