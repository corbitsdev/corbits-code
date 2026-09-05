# tui

Shipping OpenTUI shell and co-located TUI modules. Pure TypeScript / imperative `@opentui/core` surfaces live here; the runner mounts this tree as the product shell.

## Modules

| Path               | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `geometry/`        | Pure zone registry + `resolveGeometry`                          |
| `focus/`           | Focus tree + scroll lease state machine                         |
| `list-viewport.ts` | Pure list windowing kit                                         |
| `chrome-state.ts`  | Live task/agents → `setChromeZones` lines                       |
| `shell.ts`         | App shell frame (`createAppShell`) — OpenTUI **core class** API |

## Live chrome zones

Product host owns task / subagent state and pushes snapshots (event or poll):

```ts
import { formatChromeZones, setChromeZones } from "./index";

// On task/subagent change:
setChromeZones(
  shell,
  formatChromeZones({
    task: { title: "wire host", status: "doing", remaining: 1 },
    agents: [{ agentId: "explorer", description: "map callers", status: "running" }],
  }),
);
// null lines hide the zone; geometry measures heights (never guessed here).
```

## Live subagent observe

Host enters with real child rows + label; appends child events while focused; Esc restores parent.

```ts
import {
  appendObserveStreamRow,
  appendStreamRow,
  enterSubagentObserve,
  leaveSubagentObserve,
} from "./shell";

enterSubagentObserve(shell, {
  sessionId: child.id,
  agentId: child.agentId,
  description: child.description,
  lines: childRows, // live seed from store
});
// Child deltas while observing:
appendObserveStreamRow(shell, { role: "assistant", text: "…" });
// Parent reactor events still use appendStreamRow — they land on the parent
// snapshot and reappear on leave (not mixed into the child view).
appendStreamRow(shell, parentRow);
// Esc or:
leaveSubagentObserve(shell);
```

Demo/fixture path (`makeObserveFixture`) is unchanged for `v` / palette observe.

## App shell

```ts
import { createAppShell, appendTranscript } from "./shell";

// renderer from createCliRenderer() or createTestRenderer()
const shell = createAppShell(renderer, { title: "corbits" });
appendTranscript(shell, "hello");
// Tab toggles prompt ↔ transcript focus via focus module
// stickyScroll follows bottom until operator scrolls up (FOLLOW / PINNED)
```

Interactive demo (TTY): `bun src/tui/demo.ts`

Binding for the shell frame: **core-class** (not Solid) — VNode ScrollBox broke `scrollTop` in the spike; class `ScrollBoxRenderable` is required for sticky/scroll leases.
