import { EventEmitter } from "node:events";
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

function fakeEventStdin(): NodeJS.ReadStream & EventEmitter {
  const stream = new EventEmitter() as NodeJS.ReadStream & EventEmitter;
  stream.isTTY = true;
  stream.read = () => null;
  return stream;
}

test("strips SGR mouse sequences before Ink sees them", () => {
  const stdin = createFilteredStdin(fakeStdin(["\x1b[<0;39;38M"]));
  expect(stdin.read()).toBe("");
});

test("keeps surrounding text but removes embedded mouse sequences", () => {
  const stdin = createFilteredStdin(fakeStdin(["a\x1b[<0;39;38Mb\x1b[<0;39;38mc"]));
  expect(stdin.read()).toBe("abc");
});

test("passes ordinary input through untouched", () => {
  const stdin = createFilteredStdin(fakeStdin(["hello"]));
  expect(stdin.read()).toBe("hello");
});

test("proxies non-read properties to the source stream", () => {
  const stdin = createFilteredStdin(fakeStdin([]));
  expect(stdin.isTTY).toBe(true);
});

test("returns null when the source is drained", () => {
  const stdin = createFilteredStdin(fakeStdin([]));
  expect(stdin.read()).toBeNull();
});

test("strips a mouse sequence split across two reads", () => {
  const stdin = createFilteredStdin(fakeStdin(["a\x1b[<64", ";1;1Mb"]));
  // The first read holds back the incomplete trailing `[<64`, so nothing leaks.
  expect(stdin.read()).toBe("a");
  // The second read completes it and the sequence is stripped.
  expect(stdin.read()).toBe("b");
});

test("does not buffer a bare trailing ESC (would swallow an Esc keypress)", () => {
  const stdin = createFilteredStdin(fakeStdin(["\x1b"]));
  expect(stdin.read()).toBe("\x1b");
});

test("strips via the read(size) overload", () => {
  const stdin = createFilteredStdin(fakeStdin(["x\x1b[<0;1;1My"]));
  expect(stdin.read(1024)).toBe("xy");
});

test("no mouse bytes survive Ink's read loop", () => {
  const stdin = createFilteredStdin(
    fakeStdin(["type \x1b[<0;5;5M", "\x1b[<64;5;5Mmore"]),
  );
  // Mirror Ink's drain: `while ((chunk = stdin.read()) !== null)`.
  let drained = "";
  for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) {
    drained += chunk;
  }
  expect(drained).toBe("type more");
  expect(drained).not.toContain("[<");
});

// Regression: when a mouse sequence's leading ESC lands in one read (consumed
// by Ink's escape parser) and the body `[<65;18;49m` lands in the next read
// alone, the fragment must still be stripped rather than leaking as literal
// text into the prompt.
test("strips an orphaned mouse fragment whose ESC arrived in a prior read", () => {
  const stdin = createFilteredStdin(fakeStdin(["\x1b", "[<65;18;49m"]));
  // ESC passes through (it may be a real Esc keypress).
  expect(stdin.read()).toBe("\x1b");
  // The orphaned fragment is stripped, not echoed.
  expect(stdin.read()).toBe("");
});

// Regression: a wheel event whose ESC was consumed by Ink and whose body then
// splits across two reads (`[<64;64` then `;58M`) must be buffered and stripped,
// not leaked as literal `[<64;64;58M` into the prompt.
test("buffers an ESC-less mouse fragment split across two reads", () => {
  const stdin = createFilteredStdin(fakeStdin(["a[<64;64", ";58M"]));
  expect(stdin.read()).toBe("a");
  expect(stdin.read()).toBe("");
});

test("strips mouse sequences from data events", () => {
  const source = fakeEventStdin();
  const stdin = createFilteredStdin(source);
  const chunks: string[] = [];

  stdin.on("data", (chunk) => chunks.push(String(chunk)));
  source.emit("data", "hello[<67;88;45M\x1b[<65;1;1Mworld");

  expect(chunks).toEqual(["helloworld"]);
});

test("buffers split mouse fragments from data events", () => {
  const source = fakeEventStdin();
  const stdin = createFilteredStdin(source);
  const chunks: string[] = [];

  stdin.on("data", (chunk) => chunks.push(String(chunk)));
  source.emit("data", "type [<64;88");
  source.emit("data", ";45M more");

  expect(chunks).toEqual(["type ", " more"]);
});

test("once data listeners ignore empty mouse-only chunks", () => {
  const source = fakeEventStdin();
  const stdin = createFilteredStdin(source);
  const chunks: string[] = [];

  stdin.once("data", (chunk) => chunks.push(String(chunk)));
  source.emit("data", "[<67;88;45M");
  source.emit("data", "typed");

  expect(chunks).toEqual(["typed"]);
});
