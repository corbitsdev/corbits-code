# Ink delete blockers (post–OpenTUI cutover)

**Date:** 2026-05-08  
**Scope:** Read-only audit of Ink production mounts and `ink` / `ink-testing-library` imports under `src/`.  
**Policy:** Hard cutover only (`docs/tui-migration-cutover.md`). This doc lists **file:line blockers** for removing the Ink dependency after OpenTUI is the shipping shell. It does **not** authorize deletion or entry-point edits.

**Related:** `docs/tui-cutover-readiness.md`, `docs/tui-ink-freeze.md`, `docs/plans/opentui-platform-wave2.md`.

---

## Status snapshot

| Layer | Ink today? | Notes |
|-------|------------|--------|
| CLI production entry | **Yes** | `src/index.ts` → `runTUI` / `runOnboarding` (Ink) |
| OpenTUI tree | **No** | `src/tui-opentui/**` has zero `ink` imports |
| `src/tui/**` shell UI | **Yes** | Entire React/Ink component tree |
| package deps | **Yes** | `ink`, `ink-testing-library`, `react`, `@types/react`, `yoga-layout` (devDependencies) |

---

## 1. Production Ink mounts (`render` from `ink`)

These are the **only** production `ink.render(...)` call sites under `src/`. Deleting Ink without replacing them breaks the interactive CLI.

| Mount | File:line | Export / caller | What it mounts |
|-------|-----------|-----------------|----------------|
| **Main chat shell** | `src/tui/runner.tsx:3` (import), **`:1441`** (`render`) | `runTUI` ← `src/index.ts:10,78,94` | `<App …>` (full session UI) |
| **First-run onboarding** | `src/tui/onboarding.tsx:1–2` (import), **`:298`** (`render`) | `runOnboarding` ← `src/index.ts:9,73,99` | `<ProviderSetupPanel …>` |
| **Resume picker** | `src/tui/pick-session.tsx:1` (import), **`:38`** (`render`) | `pickSession` ← `src/tui/runner.tsx:122,251` | `<SessionResumePicker …>` |
| **Session-mode prompt** | `src/tui/session-mode-prompt.tsx:1–2` (import), **`:153`** (`render`) | `promptSessionModeIfUnset` ← `src/tui/runner.tsx:79` | `<SessionModePanel …>` |

### CLI wiring (must flip before delete)

| File:line | Role |
|-----------|------|
| `src/index.ts:9` | `import { runOnboarding } from "./tui/onboarding.js"` |
| `src/index.ts:10` | `import { runTUI } from "./tui/runner.js"` |
| `src/index.ts:73` | `runners.runOnboarding(config)` when unconfigured |
| `src/index.ts:78` | `runners.runTUI(config)` for interactive default |
| `src/index.ts:94–99` | Default `Runners` object binds Ink implementations |

**Cutover gate:** swap these runners to OpenTUI equivalents (or a single OpenTUI entry), then remove Ink mounts. Do **not** dual-ship.

---

## 2. Production path — direct `from "ink"` imports

All production Ink imports live under `src/tui/`. None under `src/tui-opentui/`, `src/exec/`, or other product packages.

### Shell / entry / hooks

| File:line | Symbols |
|-----------|---------|
| `src/tui/runner.tsx:3` | `render` |
| `src/tui/app.tsx:1` | `Box`, `Text`, `useApp` |
| `src/tui/onboarding.tsx:1–2` | `Box`, `Text`, `useApp`, `useInput`, `render` |
| `src/tui/pick-session.tsx:1` | `render` |
| `src/tui/session-mode-prompt.tsx:1–2` | `Box`, `Text`, `useApp`, `useInput`, `render` |
| `src/tui/hooks/use-keymap.ts:1` | `useInput`, type `Key` |
| `src/tui/hooks/use-terminal-size.ts:1` | `useStdout` |

### Components (`src/tui/components/`)

| File:line | Symbols |
|-----------|---------|
| `agents-strip.tsx:1` | `Box`, `Text` |
| `agent-modal.tsx:1` | `Box`, `Text`, `useInput` |
| `at-mention/AtSuggestions.tsx:1` | `Box`, `Text` |
| `chat-input.tsx:1` | `Box`, `Text`, `useInput`, `usePaste` |
| `codex-login-modal.tsx:1` | `Box`, `Text`, `useInput` |
| `event-log.tsx:1` | `Box`, `Text` |
| `exit-confirm.tsx:1` | `Box`, `Text`, `useInput` |
| `goal-view.tsx:1` | `Box`, `Text` |
| `header.tsx:2` | `Box`, `Text` |
| `help-overlay.tsx:1` | `Box`, `Text`, `useInput` |
| `hook-panel.tsx:1` | `Box`, `Text` |
| `in-flight-indicator.tsx:1` | `Box`, `Text` |
| `login-provider-picker.tsx:1` | `Box`, `Text`, `useInput` |
| `mcp-auth-prompt.tsx:1` | `Box`, `Text` |
| `modal-stack.tsx:1` | `Box`, `Text`, `useInput` |
| `onboarding-animation.tsx:1` | `Box`, `Text`, `useInput` |
| `operator-modal.tsx:1` | `Box`, `Text`, `useInput` |
| `permission-modal.tsx:1` | `Box`, `Text`, `useInput` |
| `permissions-manager.tsx:1` | `Box`, `Text`, `useInput` |
| `plugins-manager.tsx:1` | `Box`, `Text`, `useInput` |
| `retry-banners.tsx:1` | `Box`, `Text` |
| `session-resume-picker.tsx:1` | `Box`, `Text`, `useApp`, `useInput` |
| `settings-overlay.tsx:1` | `Box`, `Text`, `useInput` |
| `status-bar.tsx:2` | `Box`, `Text` |
| `subagent-session-view.tsx:1` | `Box`, `Text` |
| `task-view.tsx:1` | `Box`, `Text` |

**Count:** 4 mount modules + `app.tsx` + 2 hooks + 26 components = **33 production files** with a direct `ink` import.

### Ink-shaped helpers (no `from "ink"`, still delete-coupled)

| File:line | Why it blocks clean delete of the Ink UI tree |
|-----------|-----------------------------------------------|
| `src/tui/styled-segment-props.ts:4–15` | `InkSegmentProps` + `inkPropsForSegment` map markdown → Ink `Text` props; used by `event-log.tsx`, `operator-modal.tsx` |
| `src/tui/stdin-filter.ts:69–70` | Comments + behavior assume Ink 7 `stdin.read()` pipeline |
| `src/tui/sync-output.ts:3–5` | Comments reference Ink 7 synchronized write; module exists for non-Ink paths but docs assume Ink |
| `src/tui/runner.tsx:1368` | Comment: Ink 7 has no `enterAltScreen` render option (alt-screen driven manually) |

These are not package-import blockers by themselves, but they must be rewritten or dropped with the Ink shell.

---

## 3. Tests — Ink / ink-testing-library

### Under `src/tui/`

| File:line | Import |
|-----------|--------|
| `src/tui/use-stream.test.ts:4–5` | `ink-testing-library` `render`, `ink` `Text` |
| `src/tui/hooks/use-gates.test.ts:5–6` | `ink-testing-library` `render`, `ink` `Text` |
| `src/tui/hooks/use-scroll-window.test.tsx:2,4` | `ink-testing-library` `render`, `ink` `Text`, `useInput` |
| `src/tui/hooks/use-keymap.test.ts:2` | type `Key` from `ink` |
| `src/tui/components/permission-modal.test.ts:3` | `ink-testing-library` `render` |

### Under `tests/unit/tui/` (all import ink and/or ink-testing-library)

`app`, `at-suggestions`, `chat-input`, `chrome-zone-budgets`, `event-log`, `exit-confirm`, `goal-view`, `header`, `help-overlay`, `hook-panel`, `in-flight-indicator`, `modal-stack`, `onboarding`, `onboarding-animation`, `operator-modal`, `permission-modal`, `permissions-manager`, `status-bar`, `task-view`, `use-gates`, `use-keymap`, `use-provider-manager`, `use-revolving-verb`, `use-scroll`, `use-spinner`, `use-terminal-size` — each `*.test.tsx` under `tests/unit/tui/` (≈26 files as of 2026-05-08).

### Test harness / tooling (Ink-coupled, no direct import)

| File:line | Role |
|-----------|------|
| `tests/setup/tui-preload.ts:8–16` | Mocks `yoga-layout` so Ink tests work under Bun `--isolate` |
| `package.json` script `test:tui` | `bun test --isolate --preload ./tests/setup/tui-preload.ts ./src/tui ./tests/unit/tui` |

Deleting Ink without migrating or dropping these tests will fail `bun run test:tui` (and any CI job that runs it). OpenTUI coverage lives under `src/tui-opentui/**/*.test.ts` (ink-free harness).

---

## 4. Docs & packaging (not runtime, still cutover work)

| Path | Classification | Note |
|------|----------------|------|
| `package.json:81–82` | **deps** | `"ink": "^7.0.4"`, `"ink-testing-library": "^4.0.0"` under **devDependencies** (still required to run the shipping TUI today) |
| `package.json:83–84,80,88` | **deps** | `react`, `react-devtools-core`, `@types/react`, `yoga-layout` — primarily for Ink |
| `docs/tui-ink-freeze.md` | docs | Freeze policy while Ink ships |
| `docs/tui-cutover-readiness.md` | docs | Product/feature blockers before delete-Ink merge |
| `docs/tui-interaction-contract.md` | docs | Ink vs target keymap table |
| `docs/IMPLEMENTATION.md` | docs | Lists ink deps and TUI layout |
| `docs/PRODUCT.md` | docs | Points at freeze policy |
| `docs/adr/opentui-binding.md` | docs | Binding ADR; hard cutover language |
| `docs/plans/opentui-platform-wave2.md` | docs | “Delete Ink only at full epic gate” |

---

## 5. Top production delete blockers (ordered)

1. **CLI still mounts Ink** — `src/index.ts:9–10,73,78,94–99` → `runTUI` / `runOnboarding`. OpenTUI is not on the production path (`src/tui-opentui` has no ink usage and is not wired).
2. **Main shell `render`** — `src/tui/runner.tsx:1441` mounts `src/tui/app.tsx` (Ink `Box`/`Text`/`useApp` at `app.tsx:1`).
3. **Satellite Ink mounts still reachable from runner** — `pick-session.tsx:38` (resume), `session-mode-prompt.tsx:153` (first session mode), `onboarding.tsx:298` (unconfigured install).
4. **Full Ink component + hook tree** — 26 components + `use-keymap.ts:1` + `use-terminal-size.ts:1` must be gone or unused after cutover (OpenTUI replacements already live under `src/tui-opentui/**` for platform kit; product wiring still incomplete — see cutover readiness).
5. **Package graph** — remove `ink`, `ink-testing-library`, and likely `react` / `@types/react` / `yoga-layout` / `react-devtools-core` once no import remains.
6. **Ink tests + preload** — 5 tests under `src/tui/` + ~26 under `tests/unit/tui/` + `tests/setup/tui-preload.ts` + `test:tui` script.

**Product feature parity blockers** (not import lines, but block *safe* delete-Ink merge) remain in `docs/tui-cutover-readiness.md` § “Blockers before delete-Ink merge” (live reactor, permissions, operator, pickers, settings/plugins/resume, mentions, observe, streaming markdown, keymap, clipboard, acceptance re-run).

---

## 6. Classification summary

| Class | What | Action at cutover |
|-------|------|-------------------|
| **Production path** | `index.ts` runners; 4 `ink.render` mounts; `app.tsx` + all listed components/hooks | Replace entry + delete or abandon Ink tree |
| **Ink-adjacent production** | `styled-segment-props`, stdin-filter assumptions, runner alt-screen comments | Port or delete with shell |
| **Tests** | 5 under `src/tui/` + ~26 under `tests/unit/tui/` + tui-preload + `test:tui` | Rewrite on OpenTUI harness or drop |
| **Docs** | freeze, cutover readiness, IMPLEMENTATION, ADR, plans | Update after delete; not runtime blockers |
| **Deps** | `ink`, `ink-testing-library`, React/yoga stack | Drop when graph is clean |
| **Non-blockers** | `src/tui-opentui/**` | Already ink-free |
| **False positives** | `run-sink`, `otel-sink`, `agent/renderer.ts` | Unrelated “sink/render” names |

---

## 7. Explicit non-goals of this audit

- No deletion of `src/tui` or Ink packages  
- No edit to `src/tui/runner.tsx` mount or `src/index.ts` entry  
- No dual-ship flag design  

When production entry is OpenTUI-only and the import table in §2–§3 is empty, Ink may be removed from the tree and `package.json`.
