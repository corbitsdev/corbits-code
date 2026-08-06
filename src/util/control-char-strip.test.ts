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

  test("removes bidirectional overrides and isolates (Trojan Source)", () => {
    const text = "safe\u202eevil\u202c and \u2066iso\u2069late";
    expect(stripTerminalControlSequences(text)).toBe("safeevil and isolate");
  });

  test("replaces line and paragraph separators with a space", () => {
    const text = "a\u2028b\u2029c";
    expect(stripTerminalControlSequences(text)).toBe("a b c");
  });

  test("removes an unterminated OSC sequence through end of text", () => {
    const text = "before \x1b]8;;http://evil";
    expect(stripTerminalControlSequences(text)).toBe("before ");
  });

  test("keeps an orphan ESC byte from leaking as visible text", () => {
    const text = "a\x1bb\x1b";
    expect(stripTerminalControlSequences(text)).toBe("a");
  });

  test("leaves markdown punctuation untouched", () => {
    const text = "**bold** `code` [link](url) _em_ | table |";
    expect(stripTerminalControlSequences(text)).toBe(text);
  });
});
