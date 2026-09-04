/**
 * Integration: the `@` path popup narrows as you type, the same contract the
 * `/` command popup already honours. Mention accept is gated on a current
 * generation and a live `@` token under the cursor.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import type { KeyEvent } from "@opentui/core";

import { wireGates } from "./gate-wire";
import { withTestRenderer } from "./harness";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  closeMentionPopup,
  createAppShell,
  handleMentionPopupKey,
  isMentionPopupOpen,
  openAtMentionSuggestions,
  setMentionSuggestionSource,
  type AppShell,
} from "./shell";

const TREE: Readonly<Record<string, readonly string[]>> = {
  "": ["AGENTS.md", "README.md", "session-notes.md", "src/"],
  "src/": ["src/session.ts", "src/shell.ts", "src/parse-session.ts"],
};

function withShell(fn: (shell: AppShell) => Promise<void>): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      });
      setMentionSuggestionSource(shell, async (prefix) => {
        const listing = TREE[prefix];
        if (listing !== undefined) return [...listing];
        // Fallback query path: the source's own prefix filter.
        const dir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
        return (TREE[dir] ?? []).filter((e) => e.startsWith(prefix));
      });
      try {
        await fn(shell);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

function printable(seq: string): KeyEvent {
  return {
    name: seq,
    sequence: seq,
    ctrl: false,
    meta: false,
    option: false,
  } as unknown as KeyEvent;
}

const BACKSPACE = {
  name: "backspace",
  sequence: "",
  ctrl: false,
  meta: false,
  option: false,
} as unknown as KeyEvent;

/** Flush the three microtask hops `openAtMentionSuggestions` takes after a key. */
async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Drive one key and let the popup's async re-query settle. */
async function type(shell: AppShell, key: KeyEvent): Promise<boolean> {
  const handled = handleMentionPopupKey(shell, key);
  await drainMicrotasks();
  return handled;
}

async function openAt(shell: AppShell, value: string): Promise<void> {
  shell.prompt.value = value;
  shell.prompt.cursorOffset = value.length;
  await openAtMentionSuggestions(shell);
}

function hangableSource(): {
  source: (prefix: string) => Promise<readonly string[]>;
  resolveNext: (entries: readonly string[]) => void;
} {
  const pending: ((entries: readonly string[]) => void)[] = [];
  return {
    source: (_prefix) =>
      new Promise<readonly string[]>((resolve) => {
        pending.push(resolve);
      }),
    resolveNext: (entries) => {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error("no pending mention lookup");
      resolve(entries);
    },
  };
}

const ROOT = TREE[""]!;

describe("@ popup narrows as you type", () => {
  test("printable keys filter the list and land in the prompt", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "read @");
      expect(shell.overlayItems.length).toBe(4);

      expect(await type(shell, printable("s"))).toBe(true);
      expect(shell.prompt.value).toBe("read @s");
      expect(shell.overlayItems).toEqual(["session-notes.md", "src/", "AGENTS.md"]);

      await type(shell, printable("e"));
      expect(shell.prompt.value).toBe("read @se");
      expect(shell.overlayItems).toEqual(["session-notes.md"]);
    });
  });

  test("backspace widens the list again", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "read @se");
      expect(shell.overlayItems).toEqual(["session-notes.md"]);

      expect(await type(shell, BACKSPACE)).toBe(true);
      expect(shell.prompt.value).toBe("read @s");
      expect(shell.overlayItems).toEqual(["session-notes.md", "src/", "AGENTS.md"]);
    });
  });

  test("substring match finds an entry the fragment does not start", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@");
      await type(shell, printable("n"));
      expect(shell.overlayItems).toEqual(["AGENTS.md", "session-notes.md"]);
    });
  });

  test("quitting mid-lookup does not write into the disposed shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        });
        const { source, resolveNext } = hangableSource();
        setMentionSuggestionSource(shell, source);

        shell.prompt.value = "read @";
        shell.prompt.cursorOffset = shell.prompt.value.length;
        const pending = openAtMentionSuggestions(shell);

        // The operator quits before the filesystem lookup answers.
        shell.dispose();
        resolveNext(["AGENTS.md", "README.md"]);

        await expect(pending).resolves.toBe(false);
        expect(shell.overlayKind).toBeNull();
        expect(isMentionPopupOpen(shell)).toBe(false);
      },
      { width: 80, height: 24 },
    );
  });

  test("no match closes the popup and leaves the typed text", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@");
      await type(shell, printable("z"));
      expect(shell.prompt.value).toBe("@z");
      expect(shell.overlayKind).toBeNull();
      expect(isMentionPopupOpen(shell)).toBe(false);
      // Mirrors `/`: no empty-state message, not even a status flash.
      expect(shell.statusFlash).toBeNull();
    });
  });

  test("deleting the @ ends the popup", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@");
      await type(shell, BACKSPACE);
      expect(shell.prompt.value).toBe("");
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("whitespace terminates the token", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@");
      await type(shell, printable(" "));
      expect(shell.prompt.value).toBe("@ ");
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("navigation keys stay with the overlay", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@");
      const down = { name: "down", ctrl: false, meta: false, option: false };
      expect(handleMentionPopupKey(shell, down as unknown as KeyEvent)).toBe(false);
    });
  });

  test("directory drill-in still lists one level down", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@");
      await type(shell, printable("s"));
      await type(shell, printable("r"));
      expect(shell.overlayItems).toEqual(["src/"]);

      acceptOverlaySelection(shell);
      // The accept splices `src/` and re-opens; let the re-query settle.
      await drainMicrotasks();
      expect(shell.prompt.value).toBe("@src/");
      expect(shell.overlayKind).toBe("mentions");
      expect(shell.overlayItems).toEqual([
        "src/session.ts",
        "src/shell.ts",
        "src/parse-session.ts",
      ]);

      // Filtering keeps working after the drill-in.
      await type(shell, printable("s"));
      expect(shell.prompt.value).toBe("@src/s");
      expect(shell.overlayItems).toEqual([
        "src/session.ts",
        "src/shell.ts",
        "src/parse-session.ts",
      ]);
    });
  });

  // CL-6698: a queued permission/operator gate must not open onto the host
  // in the middle of a mention filter session. The old close-then-reopen
  // refresh released the host between the two calls, and a gate queued
  // behind the popup drained into that gap — leaving the gate's overlay on
  // screen while `mentionPopups` still (wrongly) claimed ownership, so
  // further keystrokes went nowhere.
  test("a queued gate stays queued across a mention filter refresh", async () => {
    await withShell(async (shell) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        await openAt(shell, "@");
        expect(isMentionPopupOpen(shell)).toBe(true);

        let resolved: unknown;
        emitter.emit("permission.gate", {
          request: {
            tool: "run_shell",
            action: "Run shell command",
            subject: "bun test",
            scopes: [],
          },
          resolve: (outcome: unknown) => {
            resolved = outcome;
          },
        });

        // Queued, not opened — the mention popup still owns the host.
        expect(shell.overlayKind).toBe("mentions");
        expect(resolved).toBeUndefined();

        // Refreshing the filter must not release the host to the queued gate.
        expect(await type(shell, printable("s"))).toBe(true);
        expect(shell.prompt.value).toBe("@s");
        expect(shell.overlayKind).toBe("mentions");
        expect(isMentionPopupOpen(shell)).toBe(true);
        expect(shell.overlayItems).toEqual(["session-notes.md", "src/", "AGENTS.md"]);
        expect(resolved).toBeUndefined();

        // Mention filtering keeps working after the refresh.
        await type(shell, printable("e"));
        expect(shell.prompt.value).toBe("@se");
        expect(shell.overlayItems).toEqual(["session-notes.md"]);
        expect(isMentionPopupOpen(shell)).toBe(true);
        expect(resolved).toBeUndefined();

        // A true dismiss still drains the queue as before.
        closeMentionPopup(shell);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("a permission gate that opened during lookup keeps mentions closed", async () => {
    await withShell(async (shell) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);
      try {
        shell.prompt.value = "read @";
        shell.prompt.cursorOffset = shell.prompt.value.length;
        const pending = openAtMentionSuggestions(shell);

        emitter.emit("permission.gate", {
          request: {
            tool: "run_shell",
            action: "Run shell command",
            subject: "bun test",
            scopes: [],
          },
          resolve: () => {},
        });
        expect(shell.overlayKind).toBe("permissions");

        resolveNext(ROOT);
        expect(await pending).toBe(false);
        expect(isMentionPopupOpen(shell)).toBe(false);
        expect(shell.overlayKind).toBe("permissions");
        expect(shell.prompt.value).toBe("read @");
      } finally {
        dispose();
      }
    });
  });
});

describe("mention accept requires a live @token", () => {
  test("accept after the lookup resolves splices the live token", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      const pending = openAtMentionSuggestions(shell);
      resolveNext(ROOT);
      expect(await pending).toBe(true);
      expect(isMentionPopupOpen(shell)).toBe(true);
      const first = shell.overlayItems[0];
      expect(first).toBeDefined();

      acceptOverlaySelection(shell);
      expect(shell.prompt.value).toBe(`read @${first}`);
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("accept during an in-flight re-query does not splice", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      const first = openAtMentionSuggestions(shell);
      resolveNext(ROOT);
      expect(await first).toBe(true);
      expect(isMentionPopupOpen(shell)).toBe(true);

      expect(handleMentionPopupKey(shell, printable("s"))).toBe(true);
      expect(shell.prompt.value).toBe("read @s");
      // Second lookup is in flight; do not resolve it.

      acceptOverlaySelection(shell);
      expect(shell.prompt.value).toBe("read @s");
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();

      resolveNext(ROOT);
      await drainMicrotasks();

      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
      expect(shell.prompt.value).toBe("read @s");
    });
  });

  test("accept during an in-flight no-match re-query does not splice", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      const first = openAtMentionSuggestions(shell);
      resolveNext(ROOT);
      expect(await first).toBe(true);
      expect(isMentionPopupOpen(shell)).toBe(true);

      expect(handleMentionPopupKey(shell, printable("z"))).toBe(true);
      expect(shell.prompt.value).toBe("read @z");

      acceptOverlaySelection(shell);
      expect(shell.prompt.value).toBe("read @z");
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();

      resolveNext([]);
      await drainMicrotasks();

      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
      expect(shell.prompt.value).toBe("read @z");
    });
  });

  test("accept with cursor off the @token does not splice", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "read @");
      expect(isMentionPopupOpen(shell)).toBe(true);

      shell.prompt.cursorOffset = 0;
      acceptOverlaySelection(shell);

      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
      expect(shell.prompt.value).toBe("read @");
    });
  });

  test("accept with cursor on a different @token does not splice", async () => {
    await withShell(async (shell) => {
      const value = "see @a and @b";
      shell.prompt.value = value;
      shell.prompt.cursorOffset = "see @a".length;
      expect(await openAtMentionSuggestions(shell)).toBe(true);
      expect(isMentionPopupOpen(shell)).toBe(true);

      shell.prompt.cursorOffset = value.length;
      acceptOverlaySelection(shell);

      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
      expect(shell.prompt.value).toBe(value);
    });
  });

  test("a lookup whose cursor has left the token does not open", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      const pending = openAtMentionSuggestions(shell);
      shell.prompt.cursorOffset = 0;
      resolveNext(ROOT);

      expect(await pending).toBe(false);
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("a lookup whose cursor moved onto a different @token does not open", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      const value = "see @a and @b";
      shell.prompt.value = value;
      shell.prompt.cursorOffset = "see @a".length;
      const pending = openAtMentionSuggestions(shell);
      shell.prompt.cursorOffset = value.length;
      resolveNext(ROOT);

      expect(await pending).toBe(false);
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("closeMentionPopup during an in-flight lookup does not reopen", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      const first = openAtMentionSuggestions(shell);
      resolveNext(ROOT);
      expect(await first).toBe(true);
      expect(isMentionPopupOpen(shell)).toBe(true);

      expect(handleMentionPopupKey(shell, printable("s"))).toBe(true);
      expect(shell.prompt.value).toBe("read @s");

      closeMentionPopup(shell);
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayList).toBeNull();
      expect(shell.overlayKind).toBeNull();

      resolveNext(ROOT);
      await drainMicrotasks();

      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
      expect(shell.prompt.value).toBe("read @s");
    });
  });

  test("closeInsetOverlay during an in-flight lookup does not reopen", async () => {
    await withShell(async (shell) => {
      const { source, resolveNext } = hangableSource();
      setMentionSuggestionSource(shell, source);

      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      const first = openAtMentionSuggestions(shell);
      resolveNext(ROOT);
      expect(await first).toBe(true);
      expect(isMentionPopupOpen(shell)).toBe(true);

      expect(handleMentionPopupKey(shell, printable("s"))).toBe(true);
      expect(shell.prompt.value).toBe("read @s");

      closeInsetOverlay(shell);
      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();

      resolveNext(ROOT);
      await drainMicrotasks();

      expect(isMentionPopupOpen(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
      expect(shell.prompt.value).toBe("read @s");
    });
  });
});
