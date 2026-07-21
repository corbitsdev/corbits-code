import { describe, test, expect } from "bun:test";
import { applyKey, applyKillYank, applyPaste, type EditState, type InputKey } from "./chat-input.js";
import { emptyKillRing, type KillRing } from "../kill-ring.js";

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
  home: false,
  end: false,
  tab: false,
  ctrl: false,
  meta: false,
  shift: false,
  super: false,
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

  test("drops an unrecognized escape sequence instead of inserting it", () => {
    // A mouse SGR sequence that slipped past the stdin filter must never be
    // spliced into the buffer as literal text.
    expect(applyKey(state("hi", 2), "\u001B[<65;18;49m", key())).toEqual(state("hi", 2));
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

describe("applyKey — word movement", () => {
  test("Alt+Left moves to the start of the current word", () => {
    expect(applyKey(state("hello world", 8), "", key({ leftArrow: true, meta: true }))).toEqual(state("hello world", 6));
  });

  test("Alt+Left skips spaces before moving to the previous word", () => {
    expect(applyKey(state("hello  world", 7), "", key({ leftArrow: true, meta: true }))).toEqual(state("hello  world", 0));
  });

  test("Alt+Right moves to the end of the current word", () => {
    expect(applyKey(state("hello world", 2), "", key({ rightArrow: true, meta: true }))).toEqual(state("hello world", 5));
  });

  test("Alt+Right skips spaces before moving to the next word end", () => {
    expect(applyKey(state("hello  world", 5), "", key({ rightArrow: true, meta: true }))).toEqual(state("hello  world", 12));
  });

  test("escape-prefixed Option+Left moves by word when the terminal does not set meta", () => {
    expect(applyKey(state("hello world", 8), "\u001B[D", key({ leftArrow: true }))).toEqual(state("hello world", 6));
  });

  test("escape-prefixed Option+Right moves by word when the terminal does not set meta", () => {
    expect(applyKey(state("hello world", 2), "\u001B[C", key({ rightArrow: true }))).toEqual(state("hello world", 5));
  });

  test("readline Option+B moves to the previous word", () => {
    expect(applyKey(state("hello world", 8), "b", key({ meta: true }))).toEqual(state("hello world", 6));
  });

  test("readline Option+F moves to the next word end", () => {
    expect(applyKey(state("hello world", 2), "f", key({ meta: true }))).toEqual(state("hello world", 5));
  });
});

describe("applyKey — line movement", () => {
  test("Cmd+Left moves to the current line start", () => {
    expect(applyKey(state("one\ntwo three", 8), "", key({ leftArrow: true, super: true }))).toEqual(state("one\ntwo three", 4));
  });

  test("Cmd+Right moves to the current line end", () => {
    expect(applyKey(state("one\ntwo three\nfour", 6), "", key({ rightArrow: true, super: true }))).toEqual(state("one\ntwo three\nfour", 13));
  });

  test("Home and End use current line boundaries", () => {
    expect(applyKey(state("one\ntwo", 5), "", key({ home: true }))).toEqual(state("one\ntwo", 4));
    expect(applyKey(state("one\ntwo", 5), "", key({ end: true }))).toEqual(state("one\ntwo", 7));
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

describe("applyKey — readline character movement and deletion", () => {
  test("ctrl+b moves one character left", () => {
    expect(applyKey(state("hello", 3), "b", key({ ctrl: true }))).toEqual(state("hello", 2));
  });

  test("ctrl+b clamps at 0", () => {
    expect(applyKey(state("hello", 0), "b", key({ ctrl: true }))).toEqual(state("hello", 0));
  });

  test("ctrl+f moves one character right", () => {
    expect(applyKey(state("hello", 3), "f", key({ ctrl: true }))).toEqual(state("hello", 4));
  });

  test("ctrl+f clamps at end", () => {
    expect(applyKey(state("hello", 5), "f", key({ ctrl: true }))).toEqual(state("hello", 5));
  });

  test("ctrl+d deletes the character at point", () => {
    expect(applyKey(state("hello", 1), "d", key({ ctrl: true }))).toEqual(state("hllo", 1));
  });

  test("ctrl+d at end of buffer is a no-op", () => {
    expect(applyKey(state("hello", 5), "d", key({ ctrl: true }))).toEqual(state("hello", 5));
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

// applyKillYank drives the readline kill/yank commands. Chains thread the
// returned ring through successive calls the way the component's ref does.
describe("applyKillYank — kill commands", () => {
  const run = (
    value: string,
    cursor: number,
    input: string,
    k: Partial<InputKey>,
    ring: KillRing = emptyKillRing,
  ) => applyKillYank(state(value, cursor), ring, input, key(k));

  test("returns null for keys it does not own", () => {
    expect(run("hello", 3, "x", {})).toBeNull();
    expect(run("hello", 3, "z", { ctrl: true })).toBeNull();
    expect(run("hello", 3, "x", { meta: true })).toBeNull();
  });

  test("C-k kills from cursor to end of line", () => {
    const r = run("hello world", 5, "k", { ctrl: true })!;
    expect(r.state).toEqual(state("hello", 5));
    expect(r.ring.entries).toEqual([" world"]);
  });

  test("C-k at end of a line kills the newline", () => {
    const r = run("one\ntwo", 3, "k", { ctrl: true })!;
    expect(r.state).toEqual(state("onetwo", 3));
    expect(r.ring.entries).toEqual(["\n"]);
  });

  test("C-k at end of buffer is a no-op that keeps the ring", () => {
    const r = run("hello", 5, "k", { ctrl: true })!;
    expect(r.state).toEqual(state("hello", 5));
    expect(r.ring.entries).toEqual([]);
  });

  test("C-u kills from line start to cursor", () => {
    const r = run("hello world", 5, "u", { ctrl: true })!;
    expect(r.state).toEqual(state(" world", 0));
    expect(r.ring.entries).toEqual(["hello"]);
  });

  test("C-u respects the current line in multi-line input", () => {
    const r = run("one\ntwo three", 8, "u", { ctrl: true })!;
    expect(r.state).toEqual(state("one\nthree", 4));
    expect(r.ring.entries).toEqual(["two "]);
  });

  test("C-w kills back to the previous word start", () => {
    const r = run("hello world", 11, "w", { ctrl: true })!;
    expect(r.state).toEqual(state("hello ", 6));
    expect(r.ring.entries).toEqual(["world"]);
  });

  test("M-d kills forward to the next word end", () => {
    const r = run("hello world", 0, "d", { meta: true })!;
    expect(r.state).toEqual(state(" world", 0));
    expect(r.ring.entries).toEqual(["hello"]);
  });

  test("M-backspace kills back to the previous word start", () => {
    const r = run("hello world", 11, "", { meta: true, backspace: true })!;
    expect(r.state).toEqual(state("hello ", 6));
    expect(r.ring.entries).toEqual(["world"]);
  });

  test("consecutive kills accumulate into one ring entry", () => {
    const first = run("foo bar baz", 0, "d", { meta: true })!;
    const second = applyKillYank(first.state, first.ring, "d", key({ meta: true }))!;
    expect(second.state).toEqual(state(" baz", 0));
    expect(second.ring.entries).toEqual(["foo bar"]);
  });
});

describe("applyKillYank — yank and yank-pop", () => {
  const killOf = (text: string): KillRing =>
    applyKillYank(state(text, 0), emptyKillRing, "k", key({ ctrl: true }))!.ring;

  test("C-y with an empty ring is a handled no-op", () => {
    const r = applyKillYank(state("hi", 1), emptyKillRing, "y", key({ ctrl: true }))!;
    expect(r.state).toEqual(state("hi", 1));
  });

  test("C-y inserts the most recent kill at the cursor", () => {
    const ring = killOf("world");
    const r = applyKillYank(state("hello ", 6), ring, "y", key({ ctrl: true }))!;
    expect(r.state).toEqual(state("hello world", 11));
  });

  test("M-y without a preceding yank is unhandled", () => {
    const ring = killOf("world");
    expect(applyKillYank(state("hello", 5), ring, "y", key({ meta: true }))).toBeNull();
  });

  test("M-y after C-y replaces the yank with the previous kill", () => {
    let ring = killOf("old");
    // A fresh kill after a break: simulate a second, newer kill.
    ring = applyKillYank(state("new", 0), { ...ring, lastAction: "other" }, "k", key({ ctrl: true }))!.ring;
    const yanked = applyKillYank(state("> ", 2), ring, "y", key({ ctrl: true }))!;
    expect(yanked.state).toEqual(state("> new", 5));
    const popped = applyKillYank(yanked.state, yanked.ring, "y", key({ meta: true }))!;
    expect(popped.state).toEqual(state("> old", 5));
  });

  test("M-y cycles back around to the newest kill", () => {
    let ring = killOf("old");
    ring = applyKillYank(state("new", 0), { ...ring, lastAction: "other" }, "k", key({ ctrl: true }))!.ring;
    const yanked = applyKillYank(state("", 0), ring, "y", key({ ctrl: true }))!;
    const pop1 = applyKillYank(yanked.state, yanked.ring, "y", key({ meta: true }))!;
    const pop2 = applyKillYank(pop1.state, pop1.ring, "y", key({ meta: true }))!;
    expect(pop2.state).toEqual(state("new", 3));
  });

  test("kill then yank round-trips multi-line kills", () => {
    const killed = applyKillYank(state("one\ntwo", 3), emptyKillRing, "k", key({ ctrl: true }))!;
    const killed2 = applyKillYank(killed.state, killed.ring, "k", key({ ctrl: true }))!;
    expect(killed2.state).toEqual(state("one", 3));
    const yanked = applyKillYank(killed2.state, killed2.ring, "y", key({ ctrl: true }))!;
    expect(yanked.state).toEqual(state("one\ntwo", 7));
  });
});

// Integration-test note:  Inactive-guard tests (paste ignored when active=false)
// require rendering ChatInput inside an Ink <Box> test harness or mocking Ink's
// usePaste to capture the callback and verify it short-circuits on !active.
// This cannot be done purely — it lives in a future e2e / integration test file.
