# Keymap evaluation

Decision record for application key bindings on `@opentui/core` 0.6.6. The engine is `@opentui/keymap`.

## Recommendation

**Adopt** `@opentui/keymap` for application commands. Do not move widget-local editing, the scroll lease, or the kill ring into it.

`createDefaultOpenTuiKeymap(renderer)` installs the default parser, the event matcher, and the enabled and metadata fields. The shell registers one layer: `commands` (`name`, `run`) and `bindings` (`key`, `cmd`). Each `run` calls the existing handler in `src/tui/shell/keys.ts`. The help overlay reads those rows from the same catalog as the registration (`keymapShortcuts()` plus `promptLocalShortcuts()`).

## What stays a command body

Widget `keyBindings` cannot express policy that spans the shell:

- **Scroll lease.** One surface holds the lease. The wheel must not move the transcript while a modal is open. Arrow keys never scroll the transcript.
- **Kill ring.** Ctrl+K/U/W and Alt+D kill, Ctrl+Y yanks, Alt+Y yank-pops. Those stay Textarea-local in `prompt-kill-ring.ts`. The keymap does not bind them.
- **Ctrl+C.** Pause, stop sub-agents, and quit stay `handleCtrlC`. The keymap command calls that handler; it does not reimplement the arming window. A decision gate still declines before the arming handler runs.

Paste, overlay accept, and prompt newline chords stay where they were. Enter, Up, and Down stay in `keys.ts` because the same chord sends, steers, recalls history, or moves the caret. Ctrl+X is the held-item drop and is a keymap command.

## Checks

- [x] Use `@opentui/keymap` for application commands. Help rows for those chords come from the keymap catalog.
- [x] Leave the scroll lease, the kill ring, and Ctrl+C policy as command bodies. Widget bindings cannot express them.
- [ ] Delete `shell/keys.ts` and `keybindings.ts`. Cannot check. The dispatcher and the prompt-local catalog stay.
