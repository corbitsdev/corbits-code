import { describe, expect, test } from "bun:test";
import { defined } from "../../testkit/defined.js";
import { withTestRenderer } from "./harness";
import { shellFocusTranscript } from "./shell/chrome";
import { createAppShell } from "./shell/index";
import {
  beginYank,
  breakKillSequence,
  emptyKillRing,
  recordKill,
  removedByDelete,
  rotateYank,
} from "./prompt-kill-ring";

describe("recordKill / beginYank", () => {
  test("a single kill can be yanked back", () => {
    const ring = recordKill(emptyKillRing, "world", "forward");
    const yank = beginYank(ring, 5);
    expect(yank).not.toBeNull();
    expect(defined(yank).text).toBe("world");
  });

  test("consecutive forward kills accumulate in order", () => {
    let ring = recordKill(emptyKillRing, "foo", "forward");
    ring = recordKill(ring, "bar", "forward");
    const yank = beginYank(ring, 0);
    expect(defined(yank).text).toBe("foobar");
  });

  test("consecutive backward kills prepend so original order survives", () => {
    let ring = recordKill(emptyKillRing, "bar", "backward");
    ring = recordKill(ring, "foo", "backward");
    const yank = beginYank(ring, 0);
    expect(defined(yank).text).toBe("foobar");
  });

  test("a non-kill breaks accumulation: a later kill starts a fresh entry", () => {
    let ring = recordKill(emptyKillRing, "foo", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "bar", "forward");
    expect(ring.entries[0]).toBe("bar");
    expect(ring.entries[1]).toBe("foo");
  });

  test("empty kill text is a no-op that still breaks the sequence", () => {
    const ring = recordKill(emptyKillRing, "", "forward");
    expect(ring).toEqual(emptyKillRing);
  });
});

describe("removedByDelete", () => {
  test("an unchanged buffer records nothing", () => {
    expect(removedByDelete("你", "你")).toEqual({ text: "", at: 0 });
  });

  test("records the grapheme deleteRange dropped, not the overlapping tail", () => {
    expect(removedByDelete("你好!", "你!")).toEqual({ text: "好", at: 1 });
    expect(removedByDelete("ab你cd", "abd")).toEqual({ text: "你c", at: 2 });
  });

  test("a replacement that is not a pure deletion records nothing", () => {
    expect(removedByDelete("abcd", "abXd")).toEqual({ text: "", at: 0 });
  });

  test("a repeated prefix uses the caret hole, not the other copy", () => {
    const hole = {
      caret: 0,
      measure: (text: string) => text.length,
    };
    expect(removedByDelete("hello hello", "hello", hole)).toEqual({
      text: "hello ",
      at: 0,
    });
    expect(removedByDelete("aaa", "aa", hole)).toEqual({ text: "a", at: 0 });
  });

  test("a caret that sits on no hole keeps the longest common prefix", () => {
    expect(
      removedByDelete("hello hello", "hello", {
        caret: 7,
        measure: (text: string) => text.length,
      }),
    ).toEqual({ text: " hello", at: 5 });
  });
});

describe("rotateYank", () => {
  test("rotates to the next-older entry after a yank", () => {
    let ring = recordKill(emptyKillRing, "second", "forward");
    ring = recordKill(breakKillSequence(ring), "first", "forward");
    const yank = defined(beginYank(ring, 0));
    expect(yank.text).toBe("first");
    const rotated = rotateYank(yank.ring);
    expect(rotated).not.toBeNull();
    expect(defined(rotated).text).toBe("second");
    expect(defined(rotated).span).toEqual({ start: 0, end: 5 });
  });

  test("returns null when the previous command was not a yank", () => {
    const ring = recordKill(emptyKillRing, "text", "forward");
    expect(rotateYank(ring)).toBeNull();
  });

  test("returns null when nothing has ever been killed", () => {
    expect(rotateYank(emptyKillRing)).toBeNull();
  });

  test("wraps back to the first entry after cycling through all of them", () => {
    let ring = recordKill(emptyKillRing, "b", "forward");
    ring = recordKill(breakKillSequence(ring), "a", "forward");
    const yank = defined(beginYank(ring, 0));
    const once = defined(rotateYank(yank.ring));
    expect(once.text).toBe("b");
    const twice = defined(rotateYank(once.ring));
    expect(twice.text).toBe("a");
  });
});

describe("prompt kill ring chords", () => {
  test("ctrl+k then ctrl+y restores the tail, including a wide glyph", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "hello 🚀 world";
      shell.prompt.cursorOffset = 6;
      h.pressKey("k", { ctrl: true });
      expect(shell.prompt.value).toBe("hello ");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("hello 🚀 world");
    });
  });

  test("ctrl+u then ctrl+y yanks the killed line back through mock keys", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      await h.mockInput.typeText("hello world");
      expect(shell.prompt.value).toBe("hello world");
      h.pressKey("u", { ctrl: true });
      expect(shell.prompt.value).toBe("");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("hello world");
    });
  });

  test("ctrl+u at column 0 kills the preceding newline and yank puts it back", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "hello\nworld";
      shell.prompt.cursorOffset = 6;
      h.pressKey("u", { ctrl: true });
      expect(shell.prompt.value).toBe("helloworld");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("hello\nworld");
    });
  });

  test("consecutive ctrl+w kills accumulate and yank restores original order", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "foo bar";
      shell.prompt.cursorOffset = 7;
      h.pressKey("w", { ctrl: true });
      expect(shell.prompt.value).toBe("foo ");
      h.pressKey("w", { ctrl: true });
      expect(shell.prompt.value).toBe("");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("foo bar");
    });
  });

  test("alt+d kills the next word and ctrl+y restores it", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "foo bar";
      shell.prompt.cursorOffset = 0;
      h.pressKey("d", { meta: true });
      expect(shell.prompt.value).toBe("bar");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("foo bar");
    });
  });

  test("alt+y rotates to the next-older kill", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "older";
      shell.prompt.cursorOffset = 0;
      h.pressKey("k", { ctrl: true });
      h.pressKey("x");
      shell.prompt.value = "newer";
      shell.prompt.cursorOffset = 0;
      h.pressKey("k", { ctrl: true });
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("newer");
      h.pressKey("y", { meta: true });
      expect(shell.prompt.value).toBe("older");
    });
  });

  test("ctrl+u on a repeated prefix kills the span at the caret", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "hello hello";
      shell.prompt.cursorOffset = 6;
      h.pressKey("u", { ctrl: true });
      expect(shell.prompt.value).toBe("hello");
      expect(shell.prompt.cursorOffset).toBe(0);
      expect(shell.promptKillRing.entries[0]).toBe("hello ");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("hello hello");
    });
  });

  test("ctrl+u inside a run of the same character leaves the caret at the hole", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "aaa";
      shell.prompt.cursorOffset = 1;
      h.pressKey("u", { ctrl: true });
      expect(shell.prompt.value).toBe("aa");
      expect(shell.prompt.cursorOffset).toBe(0);
      h.pressKey("x");
      expect(shell.prompt.value).toBe("xaa");
    });
  });

  test("ctrl+u on a unique prefix still kills that prefix", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "hello world";
      shell.prompt.cursorOffset = 6;
      h.pressKey("u", { ctrl: true });
      expect(shell.prompt.value).toBe("world");
      expect(shell.prompt.cursorOffset).toBe(0);
      expect(shell.promptKillRing.entries[0]).toBe("hello ");
      h.pressKey("z", { shift: true });
      expect(shell.prompt.value).toBe("Zworld");
    });
  });

  test("ctrl+k then ctrl+y on a parked wide glyph leaves it unchanged", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "你";
      h.pressKey("k", { ctrl: true });
      expect(shell.prompt.value).toBe("你");
      expect(shell.promptKillRing.entries).toEqual([]);
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("你");
    });
  });

  test("ctrl+k then ctrl+y restores a parked CJK line", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "你好!";
      h.pressKey("k", { ctrl: true });
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("你好!");
    });
  });

  test("ctrl+w inside a wide glyph records nothing when the delete does not", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "ab你cd";
      shell.prompt.cursorOffset = 3;
      h.pressKey("w", { ctrl: true });
      expect(shell.prompt.value).toBe("ab你cd");
      expect(shell.promptKillRing.entries).toEqual([]);
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("ab你cd");
    });
  });

  test("alt+d yank restores only the span deleteRange removed", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "ab你cd";
      shell.prompt.cursorOffset = 3;
      h.pressKey("d", { meta: true });
      expect(shell.prompt.value).toBe("abd");
      expect(shell.promptKillRing.entries[0]).toBe("你c");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("ab你cd");
    });
  });

  test("ctrl+k still kills prompt text while the transcript is focused", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      shell.prompt.value = "hello";
      shell.prompt.cursorOffset = 0;
      shellFocusTranscript(shell);
      expect(shell.prompt.focused).toBe(false);
      h.pressKey("k", { ctrl: true });
      expect(shell.prompt.value).toBe("");
      h.pressKey("y", { ctrl: true });
      expect(shell.prompt.value).toBe("hello");
    });
  });
});
