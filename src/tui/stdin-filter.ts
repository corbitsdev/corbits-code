import { EventEmitter } from "node:events";

// SGR mouse tracking sequences arrive as `ESC[<button;col;row` terminated by
// `M` (press) or `m` (release). Ink's input parser turns whatever it reads into
// string events and broadcasts them to every `useInput` handler, so any sequence
// that survives to that point leaks into text inputs as literal `[<...` garbage.
// Stripping at the read boundary keeps the parser — and therefore every
// component — from ever seeing them.
const MOUSE_SEQUENCE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

// Wheel events encode button 64 (up) / 65 (down). They are the one class of
// mouse input we still act on, re-routed through a dedicated channel since they
// can no longer reach `useInput`.
const SCROLL_UP_BUTTON = 64;
const SCROLL_DOWN_BUTTON = 65;

export type FilteredStdin = {
  stdin: NodeJS.ReadStream;
  mouse: EventEmitter;
};

// Wrap a TTY stream so Ink reads mouse-free input. Scroll-wheel events are
// emitted on `mouse` as "scrollUp"/"scrollDown" before being stripped.
export function createFilteredStdin(source: NodeJS.ReadStream): FilteredStdin {
  const mouse = new EventEmitter();

  const read = (size?: number): string | null => {
    const chunk = size === undefined ? source.read() : source.read(size);
    if (chunk === null || chunk === undefined) return null;
    const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (!text.includes("\x1b[<")) return text;

    MOUSE_SEQUENCE.lastIndex = 0;
    for (let match = MOUSE_SEQUENCE.exec(text); match !== null; match = MOUSE_SEQUENCE.exec(text)) {
      const button = Number(match[1]);
      if (button === SCROLL_UP_BUTTON) mouse.emit("scrollUp");
      else if (button === SCROLL_DOWN_BUTTON) mouse.emit("scrollDown");
    }

    return text.replace(MOUSE_SEQUENCE, "");
  };

  const stdin = new Proxy(source, {
    get(target, prop) {
      if (prop === "read") return read;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.ReadStream;

  return { stdin, mouse };
}
