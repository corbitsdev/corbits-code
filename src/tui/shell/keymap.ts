/**
 * Registers `APP_CHORDS` on `@opentui/keymap`. Lookup belongs to the package.
 * There is no second switch from key name to handler.
 */
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";

import { bindAppHelp, setAppShortcutRows } from "../keybindings.js";
import type { AppShell } from "./internals.js";
import { APP_CHORDS, appHelpLines, shellIsLive } from "./shell-chords.js";

setAppShortcutRows(
  APP_CHORDS.map((row) => ({
    keys: row.keys,
    description: row.description,
  })),
);
bindAppHelp(appHelpLines);

type ShellKeymap = Keymap<Renderable, KeyEvent>;

const keymaps = new WeakMap<CliRenderer, ShellKeymap>();

function keymapFor(renderer: CliRenderer): ShellKeymap {
  const existing = keymaps.get(renderer);
  if (existing !== undefined) return existing;
  const created = createDefaultOpenTuiKeymap(renderer);
  keymaps.set(renderer, created);
  return created;
}

function helpFromKeymap(keymap: ShellKeymap): readonly string[] {
  return keymap.getCommands({ visibility: "registered" }).flatMap((command) => {
    const desc = command.desc;
    return typeof desc === "string" && desc.length > 0 ? [desc] : [];
  });
}

/** Register the shell's application layer. Dispose drops that layer. */
export function attachShellKeymap(
  renderer: CliRenderer,
  shell: AppShell,
): () => void {
  const keymap = keymapFor(renderer);
  const disposeLayer = keymap.registerLayer({
    commands: APP_CHORDS.map((chord) => ({
      name: chord.name,
      desc: `${chord.keys} — ${chord.description}`,
      enabled: () => shellIsLive(shell) && (chord.active?.(shell) ?? true),
      run: (ctx: { event: KeyEvent }): boolean => {
        // onKey already claimed this chord (slash Tab, overlay Enter, yank).
        if (ctx.event.defaultPrevented) return false;
        const handled = chord.run(shell);
        if (handled && chord.preventDefault === false)
          ctx.event.preventDefault();
        return handled;
      },
    })),
    bindings: APP_CHORDS.flatMap((chord) =>
      chord.bindings.map((key) => ({
        key,
        cmd: chord.name,
        ...(chord.preventDefault === false ? { preventDefault: false } : {}),
      })),
    ),
  });
  const disposeHelp = bindAppHelp(() => helpFromKeymap(keymap));
  return () => {
    disposeHelp();
    disposeLayer();
  };
}
