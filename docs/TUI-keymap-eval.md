# Keymap evaluation

Decision record for a global keymap on the imperative `@opentui/core` 0.6.4 surface. This record changes no code.

## Recommendation

**Decline** a global keymap. Do not adopt one later under another name, and file no follow-up. The library does not ship an application keymap, and the shell behaviors that would have to move into one are not widget bindings.

## What 0.6.4 actually provides

Bindings are per widget. `TextareaRenderable` takes `keyBindings` of `TextareaAction` (caret, selection, kill-to-line, undo, submit, and the rest of the editor action set). `SelectRenderable` takes `keyBindings` of `SelectAction`: `move-up`, `move-down`, `move-up-fast`, `move-down-fast`, `select-current`. The same shape exists on `TabSelect` and the terminal console; `Input` reuses the textarea actions. Each widget merges its defaults with the caller's list and looks up one event.

`mergeKeyBindings(defaults, custom)` in `lib/keybinding.internal.d.ts` is that merge: two `KeyBinding<Action>[]` lists become one list for one widget. It does not route across the shell, it does not know which surface holds focus, and it does not encode policy that spans widgets. There is no keymap engine package on this core. The repo depends on `@opentui/core` only.

## What stays

- `src/tui/shell/keys.ts` is the shell dispatcher: paste guard, overlay keys, prompt wheel forwarding, kill/yank orchestration, and Ctrl+C arming. It is not a binding table.
- `src/tui/keybindings.ts` is the shortcut catalog the help overlay reads. `keybindings.test.ts` drives each row through a live shell. The catalog describes chords; it does not implement them.

Neither file is a stand-in for `mergeKeyBindings`. Replacing them with widget tables would drop behavior the tables cannot express.

## Deleted if a global keymap were adopted

It is not adopted. If it were, the deletion this record refuses is:

- `src/tui/shell/keys.ts` would be deleted or reduced to widget binding tables.
- `src/tui/keybindings.ts` would be deleted in favor of `mergeKeyBindings` defaults.

Those files stay. Reducing them would drop three policies that are not widget bindings:

- **Scroll lease.** One surface holds the lease. The wheel must not move the transcript while a modal is open on top of it. Prompt wheel events are forwarded to the transcript only because the prompt itself does not scroll. Arrow keys never scroll anything: in the prompt they are caret motion or history recall, and in an overlay list they move the selection. Page keys move only the surface that holds the lease.
- **Kill ring.** The prompt kill ring (kill chords and yank / yank-pop) is shell state. Textarea delete actions discard or edit a buffer; they are not that ring.
- **Ctrl+C.** The first press pauses a busy run or clears an idle prompt. A later press inside the arming window quits, and live sub-agents insert a stop press before quit. That is session policy, not a textarea `submit` or select `select-current` binding.

## Checks

- [x] Decline a global keymap. `mergeKeyBindings` and per-widget `keyBindings` are the only real key APIs, and they are not an application map.
- [ ] Adopt a global keymap and delete `shell/keys.ts` and `keybindings.ts`. Cannot check. No keymap engine exists on this core, and the adopt path would drop the scroll lease, the kill ring, and Ctrl+C policy. Leave this unchecked.
- [x] File no follow-up. This record does not adopt a path that needs one.
