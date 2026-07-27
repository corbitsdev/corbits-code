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
// back and prepended to the next chunk rather than leaked. The leading ESC is
// optional: it is dropped whenever Ink's escape parser consumed it in a prior
// read, leaving a bare `[<...` fragment (the same case MOUSE_FRAGMENT handles).
// `[<` is the SGR private marker — no key other than the mouse emits it — so
// buffering either form is unambiguous and never swallows a boundary-split Esc
// or arrow key (those start with a bare `ESC` / `ESC[`, never `[<`).
const TRAILING_PARTIAL = /(?:\x1b)?\[<[\d;]*$/;

// Wrap a TTY stream so Ink reads mouse-free input. SGR mouse sequences are
// stripped at the read boundary; reporting is never enabled, so this is purely a
// guard against stray sequences leaking into a text field as literal text.
//
// This depends on Ink 7's input pipeline driving off `stdin.read()` (see
// ink/build/components/App.js). Bytes Ink consumes through its transient Kitty
// keyboard probe are `unshift`ed back into the stream and re-enter through
// read(), so they pass through this filter too.
export function createFilteredStdin(source: NodeJS.ReadStream): NodeJS.ReadStream {
  const strip = (text: string): string =>
    text.replace(MOUSE_SEQUENCE, "").replace(MOUSE_FRAGMENT, "");

  // Carries an incomplete trailing mouse sequence from one read/data chunk to the next.
  let pending = "";

  const filterChunk = (chunk: unknown): string => {
    const raw = typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk ?? "");

    let text = pending + raw;
    pending = "";

    // Buffer a trailing, not-yet-terminated mouse sequence so a wheel event split
    // across chunks reassembles on the next one instead of leaking. Both the
    // ESC-prefixed form and the bare `[<...` fragment (ESC already consumed by
    // Ink) are held back — the guard keys off `[<` so neither slips through.
    if (text.includes("[<")) {
      const partial = TRAILING_PARTIAL.exec(text);
      if (partial) {
        pending = partial[0];
        text = text.slice(0, text.length - partial[0].length);
      }
    }

    return strip(text);
  };

  const read = (size?: number): string | null => {
    const chunk = size === undefined ? source.read() : source.read(size);
    if (chunk === null || chunk === undefined) return null;
    return filterChunk(chunk);
  };

  const dataListeners = new WeakMap<(...args: unknown[]) => void, (...args: unknown[]) => void>();
  let stdin: NodeJS.ReadStream;

  const wrapDataListener = (listener: (...args: unknown[]) => void): ((...args: unknown[]) => void) => {
    const existing = dataListeners.get(listener);
    if (existing !== undefined) return existing;
    const wrapped = (chunk: unknown): void => {
      const filtered = filterChunk(chunk);
      if (filtered.length > 0) listener(filtered);
    };
    dataListeners.set(listener, wrapped);
    return wrapped;
  };

  stdin = new Proxy(source, {
    get(target, prop) {
      if (prop === "read") return read;
      if (prop === "on" || prop === "addListener" || prop === "prependListener") {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          const method = Reflect.get(target, prop, target) as (
            event: string | symbol,
            listener: (...args: unknown[]) => void,
          ) => NodeJS.ReadStream;
          method.call(target, event, event === "data" ? wrapDataListener(listener) : listener);
          return stdin;
        };
      }
      if (prop === "once" || prop === "prependOnceListener") {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event !== "data") {
            const method = Reflect.get(target, prop, target) as (
              event: string | symbol,
              listener: (...args: unknown[]) => void,
            ) => NodeJS.ReadStream;
            method.call(target, event, listener);
            return stdin;
          }
          const addMethod = Reflect.get(
            target,
            prop === "once" ? "on" : "prependListener",
            target,
          ) as (event: string | symbol, listener: (...args: unknown[]) => void) => NodeJS.ReadStream;
          const removeMethod = Reflect.get(target, "removeListener", target) as (
            event: string | symbol,
            listener: (...args: unknown[]) => void,
          ) => NodeJS.ReadStream;
          const wrapped = (chunk: unknown): void => {
            const filtered = filterChunk(chunk);
            if (filtered.length === 0) return;
            removeMethod.call(target, event, wrapped);
            listener(filtered);
          };
          addMethod.call(target, event, wrapped);
          return stdin;
        };
      }
      if (prop === "off" || prop === "removeListener") {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          const method = Reflect.get(target, prop, target) as (
            event: string | symbol,
            listener: (...args: unknown[]) => void,
          ) => NodeJS.ReadStream;
          method.call(target, event, event === "data" ? dataListeners.get(listener) ?? listener : listener);
          if (event === "data") dataListeners.delete(listener);
          return stdin;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.ReadStream;

  return stdin;
}
