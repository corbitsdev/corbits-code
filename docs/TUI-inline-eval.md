# Inline mode evaluation

Decision record for an inline-versus-fullscreen split on `@opentui/core` 0.6.4. This record changes no code. The shell stays a fullscreen layout with zone floors, one scroll lease, and a prompt that owns its own editing state.

## Recommendation

**Decline** inline mode. Do not adopt a scrollback-only shell, do not treat program status as a layout mode, and file no follow-up.

## What exists, and why it is not inline mode

`CliRenderer.writeToScrollback(write)` (`renderer.d.ts`) takes a `ScrollbackWriter` and commits a snapshot into terminal scrollback. The implementation throws unless `screenMode` is `"split-footer"` and `externalOutputMode` is `"capture-stdout"`. The writer must return a snapshot root. That is a split-footer capture path. It is not an inline-mode renderable, not an alternate scene, and not a fullscreen toggle.

`createScrollbackSurface` sits in the same family: a surface that commits rows into that scrollback. It does not replace the shell tree.

`ScreenMode` is `"alternate-screen" | "main-screen" | "split-footer"`. None of those values is an inline mode. The shell does not switch among them to mean "inline".

Program status is OSC 7501. `setProgramStatus` reports a `ProgramStatus` record (`types.d.ts`, "OSC 7501 Program Status Protocol"). Terminals that ignore the protocol drop the report. OSC 7511 does not appear anywhere in the 0.6.4 package. Do not invent it, and do not treat 7501 as a layout escape: it publishes status, it does not paint the transcript or the prompt.

`enableLayout: false` is not an inline escape. Creating a native scene node with that option throws `Native scene requires Yoga layout`. Do not propose it.

Nothing in the 0.6.4 types is an inline-mode renderable, an alternate inline scene, or a fullscreen-versus-inline switch.

## What inline mode would not give you

`writeToScrollback` writes a snapshot. It does not provide:

- zone floors (idle transcript floor, overlay transcript floor, prompt floor, collapse order when a floor would be breached)
- one scroll lease (wheel stays on the surface that holds it; arrows never scroll)
- overlay selectors (empty-state fail-close, painted-id accept, shared list viewport)
- the prompt kill ring

A raw scrollback log also has no place for the shell-output preview the host paints on a timer. Sticky polling exists because the preview is a zone in the fullscreen tree, not a line already committed to scrollback.

## What stays

- `src/tui/shell/layout.ts` applies terminal geometry: floors, prompt-row sync, landing split, relayout inputs.
- `src/tui/geometry/zones.ts` defines the floors and the collapse order the layout refuses to violate.
- `src/tui/shell/chrome.ts` `relayout` is the live entry that re-resolves the tree when visibility, prompt rows, or overlay mode change.
- A Timeline in `src/tui/product-host.ts` keeps the shell-output preview's sibling chrome clocks painted while a lane is live. It is not scrollback.

## Deleted if inline mode were adopted

It is not adopted. If it were, the deletion this record refuses is:

- `shell/layout.ts`, the `geometry/zones.ts` floors, and `chrome.ts` relayout would be deleted or bypassed for a scrollback-only writer.
- The live chrome Timeline would go, because a raw scrollback commit has no sticky zone to repaint.

Those files stay. Bypassing them for `writeToScrollback` would drop the floors, the single scroll lease, overlay selectors, and the prompt kill ring. None of that is implied by a scrollback snapshot.

## Checks

- [x] Decline inline mode. `writeToScrollback` is real and insufficient. Program status is OSC 7501. OSC 7511 is absent.
- [ ] Ship an inline renderable and delete the fullscreen layout. Cannot check. No such type exists in 0.6.4, and `enableLayout: false` throws rather than opting out of layout.
- [ ] Implement OSC 7511 as an inline channel. Cannot check. The sequence is not in the 0.6.4 types.
- [x] File no follow-up. This record does not adopt a path that needs one.
