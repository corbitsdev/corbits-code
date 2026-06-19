import { test, expect } from "bun:test";
import { createFilteredStdin } from "../../../src/tui/stdin-filter.js";

// A minimal stand-in for the TTY stream: read() drains a queue of chunks, and
// the filter proxies every other property straight through.
function fakeStdin(chunks: string[]): NodeJS.ReadStream {
  const queue = [...chunks];
  return {
    isTTY: true,
    read: () => (queue.length > 0 ? queue.shift()! : null),
  } as unknown as NodeJS.ReadStream;
}

test("strips SGR mouse sequences before Ink sees them", () => {
  const { stdin } = createFilteredStdin(fakeStdin(["\x1b[<0;39;38M"]));
  expect(stdin.read()).toBe("");
});

test("keeps surrounding text but removes embedded mouse sequences", () => {
  const { stdin } = createFilteredStdin(fakeStdin(["a\x1b[<0;39;38Mb\x1b[<0;39;38mc"]));
  expect(stdin.read()).toBe("abc");
});

test("passes ordinary input through untouched", () => {
  const { stdin } = createFilteredStdin(fakeStdin(["hello"]));
  expect(stdin.read()).toBe("hello");
});

test("emits scroll events for wheel buttons", () => {
  const { stdin, mouse } = createFilteredStdin(
    fakeStdin(["\x1b[<64;1;1M", "\x1b[<65;1;1M"]),
  );
  const events: string[] = [];
  mouse.on("scrollUp", () => events.push("up"));
  mouse.on("scrollDown", () => events.push("down"));
  stdin.read();
  stdin.read();
  expect(events).toEqual(["up", "down"]);
});

test("does not emit scroll for non-wheel button clicks", () => {
  const { stdin, mouse } = createFilteredStdin(fakeStdin(["\x1b[<0;39;38M"]));
  let emitted = false;
  mouse.on("scrollUp", () => { emitted = true; });
  mouse.on("scrollDown", () => { emitted = true; });
  stdin.read();
  expect(emitted).toBe(false);
});

test("proxies non-read properties to the source stream", () => {
  const { stdin } = createFilteredStdin(fakeStdin([]));
  expect(stdin.isTTY).toBe(true);
});

test("returns null when the source is drained", () => {
  const { stdin } = createFilteredStdin(fakeStdin([]));
  expect(stdin.read()).toBeNull();
});
