# OpenTUI Platform — Wave 2 status

**Branch:** `migration/opentui-tui`  
**Date:** 2026-08-05  
**Status:** Platform skeleton landed; not wired to production CLI

## What landed

| Piece | Path | Notes |
|---|---|---|
| Deps | `package.json` | `@opentui/core` / `solid` / `keymap` **0.5.1** + `solid-js` |
| Geometry | `src/tui-opentui/geometry/` | Zone registry, collapse, floors (idle 12 / inset 8) |
| Focus + scroll lease | `src/tui-opentui/focus/` | overlay > observe > shell; one lease |
| List viewport | `src/tui-opentui/list-viewport.ts` | keep-active-visible windowing |
| Harness | `src/tui-opentui/harness.ts` | headless `createTestRenderer` + chords |
| App shell | `src/tui-opentui/shell.ts` | header · sticky transcript · prompt · status (core **class** API) |
| Demo | `src/tui-opentui/demo.ts` | `bun src/tui-opentui/demo.ts` on a real TTY |

## Binding

**core class API** for scroll/focus leases (spike: VNode ScrollBox broke `scrollTop`). Solid remains the ADR composition path for denser surfaces later; shell wave used class API to stay typecheck-clean under root React `jsxImportSource`.

## Verify

```bash
bun test ./src/tui-opentui
bun run typecheck
bun run build
bun run tui:opentui-smoke
```

## Not done (next waves)

1. Wire shell into a migration-only entry (still no dual-release flag on main)
2. Transcript surface (long-log window, real stream host)
3. Prompt queue / steer / interrupt product wiring
4. Overlay host + list kit consumers (permissions, model picker)
5. Solid declarative chrome where it helps
6. Delete Ink only at full epic gate

## Production entry

`src/index.ts` / `src/tui/runner` remain **Ink**. Platform kit is importable but not the operator path yet.
