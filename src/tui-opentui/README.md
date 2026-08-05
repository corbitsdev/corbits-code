# tui-opentui

Platform kit for the OpenTUI shell on the `migration/opentui-tui` branch. Pure TypeScript modules and later Solid surfaces live here; this tree is **not** wired to the `corbits` CLI entry yet (Ink remains production until later migration tasks).

## Modules

| Path | Role |
|---|---|
| `geometry/` | Pure zone registry + `resolveGeometry` |
| `focus/` | Focus tree + scroll lease state machine |
| `list-viewport.ts` | Pure list windowing kit |
| `chrome-state.ts` | Live goal/task/agents → `setChromeZones` lines |
| `shell.ts` | App shell frame (`createAppShell`) — OpenTUI **core class** API |

## Live chrome zones

Product host owns goal / work / subagent state and pushes snapshots (event or poll):

```ts
import { formatChromeZones, setChromeZones } from "./index"

// On goal/task/subagent change:
setChromeZones(shell, formatChromeZones({
  goal: { title: "ship cutover", phase: "implementing", status: "active" },
  task: { title: "wire host", status: "doing", remaining: 1 },
  agents: [{ agentId: "explore", description: "map callers", status: "running" }],
}))
// null lines hide the zone; geometry measures heights (never guessed here).
```

## App shell

```ts
import { createAppShell, appendTranscript } from "./shell"

// renderer from createCliRenderer() or createTestRenderer()
const shell = createAppShell(renderer, { title: "corbits" })
appendTranscript(shell, "hello")
// Tab toggles prompt ↔ transcript focus via focus module
// stickyScroll follows bottom until operator scrolls up (FOLLOW / PINNED)
```

Interactive demo (TTY): `bun src/tui-opentui/demo.ts`

Binding for the shell frame: **core-class** (not Solid) — VNode ScrollBox broke `scrollTop` in the spike; class `ScrollBoxRenderable` is required for sticky/scroll leases.
