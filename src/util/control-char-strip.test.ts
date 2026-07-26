import { describe, test, expect } from "bun:test";
import { stripTerminalControlSequences } from "./control-char-strip.js";

describe("stripTerminalControlSequences", () => {
  test("removes an OSC 52 clipboard-hijack payload", () => {
    const text = "look: \x1b]52;c;ZXZpbA==\x07 done";
    expect(stripTerminalControlSequences(text)).toBe("look:  done");
  });

  test("removes CSI sequences (cursor movement, SGR color)", () => {
    const text = "\x1b[2J\x1b[31mred text\x1b[0m plain";
    expect(stripTerminalControlSequences(text)).toBe("red text plain");
  });

  test("removes bare C0 and C1 control bytes", () => {
    const text = "a\x00b\x1fc\x7fd\x9ee";
    expect(stripTerminalControlSequences(text)).toBe("abcde");
  });

  test("keeps intentional whitespace: tab, newline, carriage return", () => {
    const text = "line1\nline2\tindented\r\n";
    expect(stripTerminalControlSequences(text)).toBe(text);
  });

  test("leaves plain text untouched", () => {
    const text = "no control sequences here, just [brackets] and text";
    expect(stripTerminalControlSequences(text)).toBe(text);
  });
});
