/**
 * Application chords on `@opentui/keymap`. The package looks the chord up;
 * `ShellKeymapDispatch` in keys.ts is the command body. Prompt kill, newline,
 * and contextual Enter / Up / Down stay out of this layer.
 */
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";

import { keymapShortcuts } from "../keybindings.js";
import type { ShellKeymapDispatch } from "./keys.js";

type ShellKeymap = Keymap<Renderable, KeyEvent>;

const keymaps = new WeakMap<CliRenderer, ShellKeymap>();

/**
 * Terminals that cannot report Shift+Tab send `backtab`. It is not a named
 * key in the default parser, so a string binding would become a letter sequence.
 */
const EFFORT_BACKTAB = { name: "backtab" } as const;

function keymapFor(renderer: CliRenderer): ShellKeymap {
  const existing = keymaps.get(renderer);
  if (existing !== undefined) return existing;
  const created = createDefaultOpenTuiKeymap(renderer);
  keymaps.set(renderer, created);
  return created;
}

function runCommand(
  command: string,
  dispatch: ShellKeymapDispatch,
  key: KeyEvent,
): boolean {
  switch (command) {
    case "shell.dismiss":
      return dispatch.escape(key);
    case "shell.interrupt":
      return dispatch.ctrlC(key);
    case "shell.copy":
      return dispatch.copy(key);
    case "shell.mouse":
      return dispatch.mouse(key);
    case "shell.expand":
      return dispatch.expand(key);
    case "shell.tasks":
      return dispatch.tasks(key);
    case "shell.observe":
      return dispatch.observe(key);
    case "shell.focus":
      return dispatch.focus(key);
    case "shell.effort":
      return dispatch.effort(key);
    case "shell.cancel":
      return dispatch.cancel(key);
    case "shell.queue":
      return dispatch.queue(key);
    case "shell.held.drop":
      return dispatch.heldDrop(key);
    default:
      return false;
  }
}

/** Register the shell's application layer. Dispose unregisters that layer. */
export function attachShellKeymap(
  renderer: CliRenderer,
  dispatch: ShellKeymapDispatch,
): () => void {
  const keymap = keymapFor(renderer);
  const rows = keymapShortcuts();
  return keymap.registerLayer({
    commands: rows.map((row) => ({
      name: row.command ?? "",
      desc: row.description,
      run(ctx: { event: KeyEvent }): boolean {
        const command = row.command;
        if (command === undefined) return false;
        return runCommand(command, dispatch, ctx.event);
      },
    })),
    bindings: [
      ...rows.flatMap((row) =>
        (row.bindings ?? []).map((key) => ({
          key,
          cmd: row.command ?? "",
          // Esc must not stopPropagation. The engine pairs that with
          // preventDefault, and the list modal's own listener still has to run.
          ...(row.command === "shell.dismiss" ? { preventDefault: false } : {}),
        })),
      ),
      { key: EFFORT_BACKTAB, cmd: "shell.effort" },
    ],
  });
}
