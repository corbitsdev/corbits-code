/**
 * Registers `APP_CHORDS` on `@opentui/keymap`. Lookup belongs to the package.
 * There is no second switch from key name to handler.
 *
 * The default host keeps its keypress listener until the destroy event, but
 * `isDestroyed` flips first and leftover stdin then throws inside
 * `getLiveHost`. This host unsubscribes inside `destroy()` and ignores any
 * keypress already queued for this turn.
 */
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { Keymap, type KeymapHost } from "@opentui/keymap";
import {
  registerDefaultKeys,
  registerEnabledFields,
  registerMetadataFields,
} from "@opentui/keymap/addons";
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui";

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
const detached = new WeakSet<CliRenderer>();
const pressListeners = new WeakMap<
  CliRenderer,
  ((event: KeyEvent) => void)[]
>();

function guardHost(renderer: CliRenderer): KeymapHost<Renderable, KeyEvent> {
  const host = createOpenTuiKeymapHost(renderer);
  const onKeyPress = host.onKeyPress.bind(host);
  const onKeyRelease = host.onKeyRelease.bind(host);
  const offs: (() => void)[] = [];
  const ignore = (): boolean => detached.has(renderer) || renderer.isDestroyed;

  const wrap = (
    subscribe: (listener: (event: KeyEvent) => void) => () => void,
    listener: (event: KeyEvent) => void,
    record: boolean,
  ): (() => void) => {
    const wrapped = (event: KeyEvent): void => {
      if (ignore()) return;
      listener(event);
    };
    if (record) {
      const list = pressListeners.get(renderer) ?? [];
      list.push(wrapped);
      pressListeners.set(renderer, list);
    }
    const off = subscribe(wrapped);
    offs.push(off);
    return off;
  };

  host.onKeyPress = (listener) => wrap(onKeyPress, listener, true);
  host.onKeyRelease = (listener) => wrap(onKeyRelease, listener, false);

  const originalDestroy = renderer.destroy.bind(renderer);
  renderer.destroy = () => {
    if (!detached.has(renderer)) {
      detached.add(renderer);
      for (const off of offs) off();
      offs.length = 0;
    }
    originalDestroy();
  };

  return host;
}

function keymapFor(renderer: CliRenderer): ShellKeymap {
  const existing = keymaps.get(renderer);
  if (existing !== undefined) return existing;
  const keymap = new Keymap(guardHost(renderer));
  registerDefaultKeys(keymap);
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  keymaps.set(renderer, keymap);
  return keymap;
}

/** True while this renderer's keymap is still subscribed to keypress. */
export function shellKeymapListening(renderer: CliRenderer): boolean {
  return keymaps.has(renderer) && !detached.has(renderer);
}

/**
 * Re-enter the keymap press listeners. After destroy they must return
 * without calling into a destroyed host.
 */
export function pokeShellKeymapPress(renderer: CliRenderer): void {
  for (const listener of pressListeners.get(renderer) ?? []) {
    listener({ name: "c" } as KeyEvent);
  }
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
