import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { enterAltScreen } from "../../../src/util/alt-screen.js";

describe("enterAltScreen", () => {
  let writes: string[];
  let onceListeners: Array<{ event: string; fn: (...args: unknown[]) => void }>;
  let removedListeners: Array<{ event: string; fn: (...args: unknown[]) => void }>;

  const origWrite = process.stdout.write.bind(process.stdout);
  const origOnce = process.once.bind(process);
  const origRemoveListener = process.removeListener.bind(process);

  beforeEach(() => {
    writes = [];
    onceListeners = [];
    removedListeners = [];

    process.stdout.write = (chunk: Uint8Array | string, ..._rest: unknown[]): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    process.once = (event: string, fn: (...args: unknown[]) => void): typeof process => {
      onceListeners.push({ event, fn });
      return process;
    };

    process.removeListener = (event: string, fn: (...args: unknown[]) => void): typeof process => {
      removedListeners.push({ event, fn });
      return process;
    };
  });

  afterEach(() => {
    process.stdout.write = origWrite as typeof process.stdout.write;
    process.once = origOnce as typeof process.once;
    process.removeListener = origRemoveListener as typeof process.removeListener;
  });

  it("writes the enter sequence to stdout", () => {
    enterAltScreen();
    expect(writes).toContain("\x1b[?1049h");
  });

  it("registers an exit listener", () => {
    enterAltScreen();
    expect(onceListeners.some((l) => l.event === "exit")).toBe(true);
  });

  it("cleanup writes the exit sequence to stdout", () => {
    const cleanup = enterAltScreen();
    writes = [];
    cleanup();
    expect(writes).toContain("\x1b[?1049l");
  });

  it("cleanup removes the exit listener", () => {
    const cleanup = enterAltScreen();
    const registered = onceListeners.find((l) => l.event === "exit");
    expect(registered).toBeDefined();
    cleanup();
    expect(removedListeners.some((l) => l.event === "exit" && l.fn === registered!.fn)).toBe(true);
  });
});
