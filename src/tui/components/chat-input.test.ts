import { describe, test, expect } from "bun:test";
import { applyKey, applyPaste, type EditState, type InputKey } from "./chat-input.js";

const state = (value: string, cursor: number): EditState => ({ value, cursor });

// Shorthand key builders
const key = (overrides: Partial<InputKey> = {}): InputKey => ({
  leftArrow: false,
  rightArrow: false,
  backspace: false,
  delete: false,
  return: false,
  escape: false,
  upArrow: false,
  downArrow: false,
  tab: false,
  ctrl: false,
  meta: false,
  shift: false,
  ...overrides,
});

describe("applyKey — newline on Shift/Alt+Enter", () => {
  test("Shift+Enter inserts a newline at the cursor", () => {
    expect(applyKey(state("ab", 1), "", key({ return: true, shift: true }))).toEqual(state("a\nb", 2));
  });

  test("Alt/Option+Enter also inserts a newline", () => {
    expect(applyKey(state("ab", 2), "", key({ return: true, meta: true }))).toEqual(state("ab\n", 3));
  });

  test("plain Enter is a no-op in applyKey (the caller submits)", () => {
    expect(applyKey(state("ab", 1), "", key({ return: true }))).toEqual(state("ab", 1));
  });
});

describe("applyKey — character insertion", () => {
  test("appends when cursor is at end", () => {
    expect(applyKey(state("hi", 2), "!", key())).toEqual(state("hi!", 3));
  });

  test("inserts mid-string and advances cursor", () => {
    expect(applyKey(state("hllo", 1), "e", key())).toEqual(state("hello", 2));
  });

  test("inserts at position 0", () => {
    expect(applyKey(state("ello", 0), "h", key())).toEqual(state("hello", 1));
  });

  test("ignores empty input", () => {
    expect(applyKey(state("hi", 2), "", key())).toEqual(state("hi", 2));
  });
});

describe("applyKey — backspace", () => {
  test("deletes char before cursor at end", () => {
    expect(applyKey(state("hello", 5), "", key({ backspace: true }))).toEqual(state("hell", 4));
  });

  test("deletes char before cursor mid-string", () => {
    // cursor=3 in "helo" → deletes index 2 ('l') → "heo", cursor=2
    expect(applyKey(state("helo", 3), "", key({ backspace: true }))).toEqual(state("heo", 2));
  });

  test("no-op at position 0", () => {
    expect(applyKey(state("hi", 0), "", key({ backspace: true }))).toEqual(state("hi", 0));
  });

  test("no-op on empty string", () => {
    expect(applyKey(state("", 0), "", key({ backspace: true }))).toEqual(state("", 0));
  });
});

describe("applyKey — forward delete", () => {
  test("deletes char at cursor when not at end", () => {
    expect(applyKey(state("hello", 0), "", key({ delete: true }))).toEqual(state("ello", 0));
  });

  test("deletes char at cursor mid-string", () => {
    expect(applyKey(state("helo", 2), "", key({ delete: true }))).toEqual(state("heo", 2));
  });

  test("no-op at end of string", () => {
    expect(applyKey(state("hi", 2), "", key({ delete: true }))).toEqual(state("hi", 2));
  });

  test("no-op on empty string", () => {
    expect(applyKey(state("", 0), "", key({ delete: true }))).toEqual(state("", 0));
  });
});

describe("applyKey — left arrow", () => {
  test("moves cursor left", () => {
    expect(applyKey(state("hi", 2), "", key({ leftArrow: true }))).toEqual(state("hi", 1));
  });

  test("clamps at 0", () => {
    expect(applyKey(state("hi", 0), "", key({ leftArrow: true }))).toEqual(state("hi", 0));
  });
});

describe("applyKey — right arrow", () => {
  test("moves cursor right", () => {
    expect(applyKey(state("hi", 0), "", key({ rightArrow: true }))).toEqual(state("hi", 1));
  });

  test("clamps at string length", () => {
    expect(applyKey(state("hi", 2), "", key({ rightArrow: true }))).toEqual(state("hi", 2));
  });
});

describe("applyKey — Home / End via ctrl sequences", () => {
  test("Home (ctrl+a) jumps to start", () => {
    // Ink reports ctrl+a as input='a' with ctrl=true; we treat it as Home
    expect(applyKey(state("hello", 3), "a", key({ ctrl: true }))).toEqual(state("hello", 0));
  });

  test("End (ctrl+e) jumps to end", () => {
    expect(applyKey(state("hello", 1), "e", key({ ctrl: true }))).toEqual(state("hello", 5));
  });

  test("other ctrl combos are no-ops", () => {
    expect(applyKey(state("hello", 3), "z", key({ ctrl: true }))).toEqual(state("hello", 3));
  });
});

describe("applyKey — keys that should not mutate state", () => {
  test("return does not modify value", () => {
    expect(applyKey(state("hello", 5), "", key({ return: true }))).toEqual(state("hello", 5));
  });

  test("escape does not modify value", () => {
    expect(applyKey(state("hello", 3), "", key({ escape: true }))).toEqual(state("hello", 3));
  });

  test("tab does not modify value", () => {
    expect(applyKey(state("hello", 2), "", key({ tab: true }))).toEqual(state("hello", 2));
  });

  test("meta combos are no-ops", () => {
    expect(applyKey(state("hello", 2), "x", key({ meta: true }))).toEqual(state("hello", 2));
  });

  test("up/down arrows are no-ops (reserved for suggestion nav)", () => {
    expect(applyKey(state("hello", 2), "", key({ upArrow: true }))).toEqual(state("hello", 2));
    expect(applyKey(state("hello", 2), "", key({ downArrow: true }))).toEqual(state("hello", 2));
  });
});

describe("applyPaste — insertion at cursor", () => {
  test("empty text is a no-op", () => {
    expect(applyPaste(state("hello", 3), "")).toEqual(state("hello", 3));
  });

  test("inserts at the start of input", () => {
    expect(applyPaste(state("world", 0), "hello ")).toEqual(state("hello world", 6));
  });

  test("appends at the end of input", () => {
    expect(applyPaste(state("hello", 5), " world")).toEqual(state("hello world", 11));
  });

  test("inserts in the middle of input", () => {
    expect(applyPaste(state("helorld", 3), "lo w")).toEqual(state("hello world", 7));
  });

  test("preserves cursor when paste text is multi-line (newlines)", () => {
    const result = applyPaste(state("ab", 1), "\nline2\nline3");
    expect(result.value).toBe("a\nline2\nline3b");
    expect(result.cursor).toBe(13); // 1 + len("\nline2\nline3") = 1 + 12
  });

  test("paste with @ symbols updates state the caller feeds to atMention.refresh", () => {
    // The paste handler's atMention.refresh(newValue, newCursor) call receives
    // the same value/cursor that applyPaste returns — verify the contract.
    const result = applyPaste(state("hello ", 6), "@user/project");
    expect(result.value).toBe("hello @user/project");
    expect(result.cursor).toBe(19);
  });

  test("paste at cursor 0 on empty input", () => {
    expect(applyPaste(state("", 0), "pasted")).toEqual(state("pasted", 6));
  });

  test("paste at cursor past end is clamped by slice semantics (same as appending)", () => {
    // Cursor past value.length: slice are forgiving and treat it like end.
    expect(applyPaste(state("hi", 10), "!")).toEqual(state("hi!", 11));
  });
});

// Integration-test note:  Inactive-guard tests (paste ignored when active=false)
// require rendering ChatInput inside an Ink <Box> test harness or mocking Ink's
// usePaste to capture the callback and verify it short-circuits on !active.
// This cannot be done purely — it lives in a future e2e / integration test file.
