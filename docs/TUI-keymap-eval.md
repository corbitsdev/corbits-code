# Keymap evaluation

Decision record for application key bindings on `@opentui/core` 0.6.6. The engine is `@opentui/keymap`.

## Recommendation

**Adopt** `@opentui/keymap` for application commands. Do not move widget-local editing, the scroll lease, or the kill ring into it.

`keymapFor` builds `new Keymap(guardHost(renderer))`, then registers the default parser, the enabled fields, and the metadata fields. The shell registers one layer. Each command `run` calls one existing function. There is no parallel key switch. Help lines are the keymap's registered `desc` values plus the widget-default rows.

Textarea defaults are not registered again. `renderables/Textarea.d.ts` `TextareaAction` and the shipped `defaultTextareaKeyBindings` already cover cursor motion, word motion, Ctrl+D, Ctrl+K/U/W, and Alt+D. `PROMPT_KEY_BINDINGS` already maps Enter to submit and Ctrl+Enter / Ctrl+J / Shift+Enter to newline. The kill ring only diffs those deletes and yanks.

## What stays a command body

Widget `keyBindings` cannot express policy that spans the shell:

- **Scroll lease.** One surface holds the lease. The wheel must not move the transcript while a modal is open. Arrow keys never scroll the transcript. `ScrollBoxRenderable.handleKeyPress` forwards arrows to `ScrollBarRenderable`, which scrolls on up/down. That focused arrow-scroll is not adopted.
- **Kill ring.** Textarea delete actions discard the text (`delete-to-line-end`, `delete-to-line-start`, `delete-word-backward`, `delete-word-forward` in `Textarea.d.ts`). `prompt-kill-ring.ts` stays for the diff and for yank / yank-pop. The keymap does not bind those chords.
- **Ctrl+C.** Pause, stop sub-agents, and quit stay `handleCtrlC`. The keymap command calls that handler; it does not reimplement the arming window. A decision gate still declines before the arming handler runs.

Paste, overlay accept, and prompt newline chords stay where they were. Enter, Up, and Down stay in `keys.ts` because the same chord sends, steers, recalls history, or moves the caret. Ctrl+X is the held-item drop and is a keymap command.

## Checks

- [x] Use `@opentui/keymap` for application commands. Help rows for those chords come from the keymap catalog.
- [x] Leave the scroll lease, the kill ring, and Ctrl+C policy as command bodies. Widget bindings cannot express them.
- [ ] Delete `shell/keys.ts` and `keybindings.ts`. Cannot check. The dispatcher and the prompt-local catalog stay.
