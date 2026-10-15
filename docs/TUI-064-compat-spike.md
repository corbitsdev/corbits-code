# TUI pre-0.6.0 compat spike (CL-10649)

Decision record for bumping `@opentui/core` keys in this repo from 0.5.12 to 0.6.4. The spike changes no manifest, no lockfile, and no code; it records what the 0.5.12 -> 0.6.4 delta would break here and what it would not.

## 1. Scope and method

The 0.6.4 API surface was inspected from the published tarball: `npm pack @opentui/core@0.6.4` followed by tar extraction of the `.d.ts` tree (and reading the bundled JS where a `.d.ts` claim needed runtime confirmation, e.g. the `enableLayout: false` throw). This leaves `package.json` and `bun.lock` untouched. Baseline claims were diffed against the 0.5.12 `.d.ts` tree already resolvable from the current pin.

Repo facts the spike assumes:

- `@opentui/core` is pinned at `0.5.12` (package.json:108) with 8 platform `optionalDependencies` pins at the same version (package.json:128-135). A real bump must move all 9 pins plus `bun.lock` in one step.
- The TUI is the imperative core surface: no React, no Solid, no `@opentui` keymap. `src/tui/**` constructs and wires framework renderables directly (ScrollBox, Select, Textarea, Markdown).
- Mouse wheel scroll, hover-armed links, and frame assertions against the painted buffer are the load-bearing behaviors; the regression tests read the painted frame through `captureCharFrame` and `captureSpans`.

## 2. Breaker inventory

Thirteen reflective or monkeypatch sites in `src/tui/**`, with the 0.6.4 disposition of the API each site leans on. "Keep" means the symbols still exist with the same shape in 0.6.4 and needs no code change; "verify" means the symbols survive but their behavior must be re-checked at bump.

| #   | Site                                              | What it does                                                                                                                                                                                                                      | 0.6.4 disposition                                                                                | Risk                                                                                                                                                                                                                              |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | shell/overlay-list.ts:144-152                     | Reflective `Object.getOwnPropertyDescriptor(select, name)` reads of Select's private `scrollOffset` / `maxVisibleItems` to compute the painted window; any shape miss defaults offset to 1 (overlay-list.ts:146)                  | Keep: the hack stays necessary -- both fields are still `private` on `SelectRenderable` in 0.6.4 | CL-10639/CL-10642 must not assume this read keeps working across refactors of Select internals; no accessor exposure was added in 0.6.4                                                                                           |
| 2   | shell/overlay-list.ts:128-133,164,190-206,240-244 | Placeholder-option pattern: a real `SelectRenderable` gets empty `SelectOption[]` rows (`name: ""`, `description: ""`) and is rebuilt on reshape; the shell paints visible rows itself                                            | Keep                                                                                             | Keyboard and selection geometry come from native Select, rows do not; a Select paint change under the placeholders would double-paint or blank rows                                                                               |
| 3   | shell/keys.ts:300-305                             | Instance overwrite of protected `onMouseEvent` on prompt and transcript via `as unknown as`, forwarding every `event.type === "scroll"` to the transcript                                                                         | Keep, verify                                                                                     | 0.6.4 still declares `processMouseEvent` / protected `onMouseEvent`; dispatch is expected to move to native-integration hooks (`defineNativeIntegration`), so where the override gets called from may shift -- verify at bump     |
| 4   | url-links.ts:363                                  | `Renderable.renderablesByNumber.get(renderer.hitTest(x, y))` static-map walk to resolve the node under the cursor                                                                                                                 | Keep, verify                                                                                     | `renderablesByNumber` is a static map on the `Renderable` class and `hitTest` is a renderer method; both survive in 0.6.4. Hit-test numbering is native, so behavior is expected to be unchanged but is not provable from `.d.ts` |
| 5   | url-links.ts:134-183, 385-404                     | `armLinkLine` (134-183) assigns all five of `onMouseDown` / `onMouseUp` / `onMouseOver` / `onMouseMove` / `onMouseOut`; `armMarkdownLinks` (385-404) assigns only down, up, and out                                               | Keep                                                                                             | Option-style mouse hooks survive in 0.6.4; hover-only paths additionally depend on pointer-motion delivery (docs/TUI.md, "URL click-through" and the scroll-lease rules at docs/TUI.md:535)                                       |
| 6   | shell/chrome.ts:644,652-658                       | Overlay host positioning: `position = "absolute"`, `zIndex = OVERLAY_FLOAT_Z`, absolute top/left/width vs in-flow relative reset                                                                                                  | Keep, verify                                                                                     | absolute + zIndex still supported in 0.6.4 options; paint-slide behavior of an absolutely positioned host under the new paint model is empirical                                                                                  |
| 7   | shell/chrome.ts:956                               | `shell.agentsBox.zIndex = 0` baseline stacking                                                                                                                                                                                    | Keep                                                                                             | Same surface as #6                                                                                                                                                                                                                |
| 8   | prompt-input.ts:51-68                             | `TextareaRenderable` plus `Object.defineProperty(area, "value")` proxying `plainText` / `setText` / `cursorOffset`                                                                                                                | Keep                                                                                             | All three are still public on `EditBufferRenderable` in 0.6.4 (plainText, setText, cursorOffset get/set) -- safe                                                                                                                  |
| 9   | prompt-input.ts:80-92                             | `visualCursor.visualRow`, `scrollY`, `lineInfo.lineStartCols` reads for caret row and wrap-intact row count                                                                                                                       | Keep                                                                                             | All still public in 0.6.4 (lineInfo, scrollY, visualCursor) -- safe                                                                                                                                                               |
| 10  | shell/index.ts:197-213                            | Transcript is a `ScrollBoxRenderable` with `stickyScroll: true`, `stickyStart: "bottom"`, and `verticalScrollBar.visible = false`                                                                                                 | Keep                                                                                             | ScrollBox / ScrollBar options preserved in 0.6.4, including stickyScroll and viewportCulling; watch the scroll lease semantics of docs/TUI.md:535 under the new attach/dispose surface                                            |
| 11  | markdown-rows.test.ts:600-622                     | Prototype-level reflection: `Object.getOwnPropertyDescriptor(MarkdownRenderable.prototype, "content")` plus a per-instance redefine of the property to count set calls                                                            | Keep, verify at bump                                                                             | `content` is still declared as a getter/setter pair on `MarkdownRenderable` in 0.6.4; this is the highest-risk test helper because redefine-on-instance depends on the accessor being own-configurable there                      |
| 12  | src/tui/_.test.ts, src/tui/runner/_.test.ts       | `captureCharFrame` / `captureSpans` reads of the painted frame: 248 call-site lines across 51 test files                                                                                                                          | Keep, verify empirically                                                                         | The API is kept and exported from `@opentui/core/testing` in 0.6.4; runtime fidelity of captured frames under the new recording-buffer paint model is the empirical unknown of this spike (see section 5)                         |
| 13  | harness.ts:143,194-200                            | `createTestRenderer` from `@opentui/core/testing` (call at harness.ts:143), `renderer.destroy()` teardown (harness.ts:194-195), and process-global tree-sitter client recreation via `getTreeSitterClient()` (harness.ts:196-199) | Keep                                                                                             | `createTestRenderer` (promise-based setup) and `getTreeSitterClient` both survive in 0.6.4, which additionally adds `dispose` / asyncDispose on the setup object                                                                  |

Note: The site in #4 is the only reflective static-map walk in the tree.

## 3. Zero-scan (auditable)

The claim "src/tui uses nothing on the removed/structural 0.6.4 surface" is checkable with these greps against a checkout with the pin still at 0.5.12. Counts re-run by this spike in the worktree tree:

```sh
grep -rn  "enableLayout" src/tui/                                        # 0 hits
grep -rnE "extends .*Renderable" src/tui/                                # 0 hits
grep -rnE "^\s*(public |protected |private )?(async )?render\(" src/tui/  # 0 hits (no render() overrides)
grep -rn  "\.render\(" src/tui/                                          # 0 hits (no .render() call sites)
grep -rnE "yogaNode|getLayoutNode" src/tui/                               # 0 hits
grep -rnE "renderBefore|renderAfter|measureFunc|frameBuffer|buffered" src/tui/  # 0 hits
grep -rnE "paintHook|frameCell|getFrameCell|paint-buffer" src/tui/        # 0 hits (no custom paint hooks)
grep -rlnE "captureCharFrame|captureSpans" src/tui/                       # 52 files: 51 test files + harness.ts (definitions)
```

Interpretation:

- No `enableLayout` values at all in src/tui, so the 0.6.4 change there (see section 5 hazard) breaks nothing today.
- No custom `Renderable` subclasses and no `render()` overrides: the repo never reimplements native paint, so the tidiest part of the 0.5.12 API removal (public `render(buffer, deltaTime)` replaced by protected `renderSelf` plus native integrations) is out of the blast radius.
- No `yogaNode` / `getLayoutNode` references: nothing migrates to the 0.6.4 `_sceneHandle` layout surface or its replacements (`setMeasureProvider`, `getLayout`, `invalidateIntrinsicSize`).
- Nothing consumes `renderBefore` / `renderAfter` / measure functions / frame buffers / buffering: no renderable marker tree surgery and no custom paint-hook or frame-cell reads in production code.
- The last grep is the count baseline for section 4.

## 4. Test-harness follow-up

Surfaces named, not counts:

- markdown-rows.test.ts:600-622 prototype reflection over `MarkdownRenderable.prototype.content` (row #11). This is the one test-side reflection with 0.6.4-breakage potential beyond frame content.
- The `captureCharFrame` / `captureSpans` suites, grouped by file (51 files; `grep -rlnE "captureCharFrame|captureSpans" src/tui/` minus harness.ts):

  approval-prompt-visibility, collapse, command-surfaces, diff-rows, focus-routing, gate-wire, harness.test, keybindings, landing, list-modal, log-sink, margins, markdown-rows, mcp-view, operator-input-required-chrome, overlay-body, overlay-empty-state, overlay-float-reset, overlay-min-geometry, overlay-overflow, overlay-paint, overlay-view, overlays, palette-paint, product-host, prompt-box, prompt-highlight, prompt-slash-exit, provider-connect, provider-setup, queued-input-chrome, ramp-paint, row-click, row-update-perf, runner-host, runtime-channels, runtime-bridge, shell, syntax-highlight, tool-rows, transcript-anchor, transcript-layout, transcript-long-log-scroll, transcript-panels, url-click, version-badge, wave6, welcome, worker-wait-chrome (all under src/tui/*.test.ts), plus src/tui/runner/settings-theme.test.ts and src/tui/runner/wiring.ask-wake.test.ts.

- e2e coupling: e2e/reactor-approval-parked-call-settles.test.ts:23 imports `withAppShell` from src/tui/test-helpers.ts, which stands on the @opentui/core/testing harness. A bump that breaks the TUI harness breaks the approval-parked-call e2e with it; a sufficient TUI test run is not a proxy for a green e2e suite. testkit/ has no opentui coupling.

## 5. Go / no-go

GO for the staged bump (CL-10647), with qualifications:

- 0.5.17 was published as an intermediate stage but was not inspected in this spike; the staged risk assessment covers 0.5.12 (baseline) and 0.6.4 (target) only. Treat 0.5.17 as a stage whose own breakers are uncalculated.
- `captureCharFrame` / `captureSpans` take a buffered frame, but 0.6.4 moves paint onto a recording-buffer model (`NativePaintRecorder`, native integration hooks). The capture API is unchanged; whether painted frames under it read as they do today cannot be determined from `.d.ts` files. This is the primary empirical question of the bump series.
- "Frame-cell readability": the tests assert text, spans, and offsets from the captured frame; character-position fidelity (column alignment, wrapped rows, margins) is the concrete fidelity property to re-measure.

Gates for CL-10647:

1. At the 0.5.17 stage: `bun run test ./src/tui` plus a capture-fidelity check (a few known-frame assertions, e.g. landing, transcript-anchor, overlay-paint) and a mouse-dispatch smoke (scroll -> wheel, ctrl-hover -> link arm).
2. At the 0.6.4 stage: apply the 13 dispositions from section 2 as a checklist, rerun the full TUI suite, then e2e (it couples to the harness per section 4).
3. Manual smoke at 80x24 in tmux plus iTerm2 and Kitty spot-checks: transcript scroll and sticky scroll, overlay open/close with float positioning, URL click-through, prompt caret row on wrapped input.

Hazard for anything written after the bump: `enableLayout: false` throws in 0.6.4 ("Native scene requires Yoga layout", thrown from `NativeScene.createNode`). Current src/tui has zero uses, but any future `enableLayout: false` here is fatal at runtime.

## 6. Corrections feeding later tickets

Fact corrections to stop wrong premises from propagating through the series:

- QRCode (CL-10648): no QR API of any kind exists in the 0.6.4 tarball. Adopt-or-decline with decline as the honest option, or source a third-party renderer; do not assume a native surface.
- detectLinks (CL-10643): `detectLinks(chunks, context)` is a standalone export in the 0.6.4 lib tree, not a Code renderable option. `onHighlight` (and `onChunks`), by contrast, are real Code options.
- Timeline (CL-10640): the 0.6.4 `Timeline` has no event API. Lifecycle is `addStateChangeListener` / `removeStateChangeListener` plus `play` / `pause` / `restart` / `update` (and `add` / `once` / `call` / `sync` for items). Tickets worked from "Timeline events" need rewording, and anything in src would live on state-change listeners.
- markdown-parser.ts (CL-10645): not wholesale-deletable when native Markdown adoption lands. It drives stream settling (`splitAtSettledBlock`, `withholdIncompleteHeading`; src/tui/markdown-parser.ts:712,827) and feeds view/lines.ts:1 and shell/transcript.ts:23 plus syntax-highlight.ts; deleting it breaks those import chains, not just native rendering.
- Log sink (CL-10641): there is no `src/tui/log-sink.ts`. The module lives at src/logging/sink.ts; src/tui/log-sink.test.ts imports it (`../logging/sink.js`), and src/tui/long-log.ts is the view-side half. References should read those two files.
- overlay-list.ts (CL-10639 and CL-10642): the "reimplements Select" framing overstates. At 308 lines it delegates selection, scroll state, and key motion to a real (placeholder-data) `SelectRenderable` and paints rows itself, plus the reflective scroll-state reads of row #1. Ordering CL-10642's ScrollBox revalidation before CL-10639 is a risk choice -- the transcript is the largest ScrollBox consumer and gates the bump -- not a code dependency.
- ScrollBox (CL-10642): the work is revalidation under 0.6.4, not first adoption. The transcript already is a `ScrollBoxRenderable` with `stickyScroll: true` (shell/index.ts:197-213), and ScrollBox / ScrollBar API is preserved in 0.6.4.
