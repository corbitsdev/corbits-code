import { EventEmitter } from "node:events";

// SGR mouse tracking sequences arrive as `ESC[<button;col;row` terminated by
// `M` (press) or `m` (release). Ink's input parser turns whatever it reads into
// string events and broadcasts them to every `useInput` handler, so any sequence
// that survives to that point leaks into text inputs as literal `[<...` garbage.
// Stripping at the read boundary keeps the parser — and therefore every
// component — from ever seeing them.
const MOUSE_SEQUENCE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

// An orphaned mouse fragment: the leading ESC was consumed by Ink's escape
// parser in a prior read (held as a pending escape) and the rest arrives here
// alone. Such a fragment reassembles into a CSI string event inside Ink and
// would otherwise reach `useInput` as literal `[<65;18;49m` text. The SGR body
// `[<digits;digits;digits[Mm]` is unambiguous for the mouse, so stripping the
// fragment is safe.
const MOUSE_FRAGMENT = /\[<(\d+);\d+;\d+[Mm]/g;

// A trailing, not-yet-terminated mouse sequence at the end of a chunk. A single
// logical sequence can be split across two `read()` calls, so the tail is held
// back and prepended to the next chunk rather than leaked. `[<` is the SGR
// private marker — no key other than the mouse emits it — so buffering this is
// unambiguous and never swallows a boundary-split Esc or arrow key (those start
// with a bare `ESC` / `ESC[`, which is deliberately not buffered).
const TRAILING_PARTIAL = /\x1b\[<[\d;]*$/;

// Wheel events encode button 64 (up) / 65 (down). They are the one class of
// mouse input we still act on, re-routed through a dedicated channel since they
// can no longer reach `useInput`.
const SCROLL_UP_BUTTON = 64;
const SCROLL_DOWN_BUTTON = 65;

// SGR mouse mode escape sequences. Mode 1000 enables basic button-event
// reporting; mode 1006 switches to the SGR extended format that supports
// coordinates beyond 223 and encodes the button value as a decimal number in
// the sequence body rather than as a single 8-bit byte. Enabling reporting is
// what makes the terminal emit the sequences this module then filters, so the
// two halves live together. These are terminal-level side effects, owned by the
// runner's lifecycle rather than a React component.
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

// Enable SGR mouse reporting and return a function that disables it. Mirrors
// enterAltScreen: an `exit` handler restores the terminal on abrupt exit so a
// crash never leaves it stuck emitting mouse sequences.
export function enableMouseReporting(): () => void {
  if (!process.stdin.isTTY) return () => {};
  const disable = (): void => {
    process.stdout.write(MOUSE_DISABLE);
  };
  process.stdout.write(MOUSE_ENABLE);
  process.once("exit", disable);
  return (): void => {
    process.removeListener("exit", disable);
    disable();
  };
}

export type FilteredStdin = {
  stdin: NodeJS.ReadStream;
  mouse: EventEmitter;
};

// Wrap a TTY stream so Ink reads mouse-free input. Scroll-wheel events are
// emitted on `mouse` as "scrollUp"/"scrollDown" before being stripped.
//
// This depends on Ink 7's input pipeline driving off `stdin.read()` (see
// ink/build/components/App.js). Bytes Ink consumes through its transient Kitty
// keyboard probe are `unshift`ed back into the stream and re-enter through
// read(), so they pass through this filter too.
export function createFilteredStdin(source: NodeJS.ReadStream): FilteredStdin {
  const mouse = new EventEmitter();

  const stripAndEmit = (text: string): string => {
    let stripped = text.replace(MOUSE_SEQUENCE, "");
    MOUSE_SEQUENCE.lastIndex = 0;
    for (const match of text.matchAll(MOUSE_SEQUENCE)) {
      emitScroll(Number(match[1]));
    }
    // Catch orphaned fragments whose leading ESC was consumed by Ink's parser in
    // a prior read. Run only on the full-sequence-free remainder so a complete
    // sequence is never counted twice.
    MOUSE_FRAGMENT.lastIndex = 0;
    for (const match of stripped.matchAll(MOUSE_FRAGMENT)) {
      emitScroll(Number(match[1]));
    }
    stripped = stripped.replace(MOUSE_FRAGMENT, "");
    return stripped;
  };

  function emitScroll(button: number): void {
    if (button === SCROLL_UP_BUTTON) mouse.emit("scrollUp");
    else if (button === SCROLL_DOWN_BUTTON) mouse.emit("scrollDown");
  }

  // Carries an incomplete trailing mouse sequence from one read to the next.
  let pending = "";

  const read = (size?: number): string | null => {
    const chunk = size === undefined ? source.read() : source.read(size);
    if (chunk === null || chunk === undefined) return null;
    const raw = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");

    let text = pending + raw;
    pending = "";

    // Buffer a trailing partial FULL-form sequence (ESC + `[<` ...). Handles two
    // split cases that otherwise leak out of Ink's escape parser: the trailing
    // digit and ESC+fragment cases both preserve enough for the pattern to reassemble on
    // the next read, preventing terminal-side ANSI sequences from leaking into output.
    if (text.includes("\x1b[<")) {
      const partial = TRAILING_PARTIAL.exec(text);
      if (partial) {
        pending = partial[0];
        text = text.slice(0, text.length - partial[0].length);
      }
    }

    return stripAndEmit(text);
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
