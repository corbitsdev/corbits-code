/**
 * The help catalog, checked against real behavior.
 *
 * Every row in `SHELL_SHORTCUTS` is looked up here by its own `keys` string and
 * driven as the bytes that string denotes: rename a chord and the lookup fails,
 * change a chord and the probe presses the new one against the old assertion.
 * A catalog row with no probe fails the coverage test outright, so a new row
 * cannot be added without someone proving it works.
 *
 * What this does not check: which description sits on which row. Swapping two
 * descriptions between rows would pass. Everything else — the chord, its
 * modifiers, the stated condition, and whether the host shadows the prompt's
 * own binding — is asserted against a live shell.
 */

import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { PROMPT_KEY_BINDINGS } from "./prompt-input.js";
import { SHELL_SHORTCUTS } from "./keybindings.js";
import { createHarness, withTestRenderer, type Harness } from "./harness.js";
import { mountRunnerHost } from "./runner-host.js";
import { openCommandSurface } from "./command-surfaces.js";
import { focusOwner } from "./focus/focus-state.js";
import { setChromeZones } from "./shell.js";
import {
  appendStreamRow,
  applyShellInterrupt,
  createAppShell,
  isSlashPopupOpen,
  leaveSubagentObserve,
  openHelpOverlay,
  setMentionSuggestionSource,
  setPaletteCatalog,
  setPaletteOnObserveRequest,
  setPromptImageSource,
  setSentMessageHistory,
  setShellBridgeHooks,
  setShellExitHandler,
  setEffortCycleHandler,
  clearShellBridgeHooks,
  setShellRunState,
  shellFocusPrompt,
  shellFocusTranscript,
  streamRowAt,
  streamRowCount,
  submitPrompt,
  truncateStreamRows,
  type AppShell,
} from "./shell.js";

/* --------------------------------------------------------------------- */
/* Chord string → the bytes a terminal actually writes                     */
/* --------------------------------------------------------------------- */

const NAMED_SEQUENCES: Readonly<Record<string, string>> = {
  Enter: "\r",
  Tab: "\t",
  Esc: "\x1b",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Left: "\x1b[D",
  Right: "\x1b[C",
};

/**
 * Bytes for one chord, or null when no terminal can encode it without the
 * kitty keyboard protocol (Ctrl+Enter is the only such chord in the catalog).
 */
function chordBytes(token: string): string | null {
  const named = NAMED_SEQUENCES[token];
  if (named !== undefined) return named;

  const ctrl = /^Ctrl\+(.)$/.exec(token);
  if (ctrl?.[1] !== undefined) {
    const letter = ctrl[1].toLowerCase();
    if (letter < "a" || letter > "z") return null;
    return String.fromCharCode(letter.charCodeAt(0) - 96);
  }

  const alt = /^Alt\+(.+)$/.exec(token);
  if (alt?.[1] !== undefined) {
    const rest = alt[1];
    const inner = NAMED_SEQUENCES[rest] ?? (rest.length === 1 ? rest.toLowerCase() : null);
    return inner === null ? null : `\x1b${inner}`;
  }

  if (token === "Ctrl+Enter") return null;
  if (token.length === 1) return token;
  return null;
}

/** Every chord a catalog row advertises, in the order the row lists them. */
function chordsOf(keys: string): readonly (string | null)[] {
  if (keys === "Arrow keys") {
    return ["Left", "Right", "Up", "Down"].map((k) => chordBytes(k));
  }
  return keys.split(" / ").map((token) => {
    const bytes = chordBytes(token.trim());
    // A token nothing can encode and that is not the known kitty-only chord is
    // a typo in the catalog, not an untestable chord.
    if (bytes === null && token.trim() !== "Ctrl+Enter" && token.trim() !== "Shift+Tab") {
      throw new Error(`catalog row "${keys}" has unreadable chord "${token.trim()}"`);
    }
    return bytes;
  });
}

/* --------------------------------------------------------------------- */
/* Probes                                                                  */
/* --------------------------------------------------------------------- */

interface ProbeContext {
  readonly h: Harness;
  readonly shell: AppShell;
  /** Bytes for each chord the row advertises; null = kitty-only. */
  readonly chords: readonly (string | null)[];
  /** Whether the host has torn down. Supplied only on a mounted host. */
  readonly hasExited?: () => boolean;
}

type Probe = (ctx: ProbeContext) => Promise<void> | void;

type Group = "editing" | "surfaces" | "session" | "host";

const PROBES: Readonly<Record<string, { readonly group: Group; readonly probe: Probe }>> = {
  "Ctrl+B / Ctrl+F": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "abc";
      shell.prompt.cursorOffset = 3;
      press(h, chords[0]);
      expect(shell.prompt.cursorOffset).toBe(2);
      press(h, chords[1]);
      expect(shell.prompt.cursorOffset).toBe(3);
    },
  },
  "Alt+B / Alt+F": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "one two";
      shell.prompt.cursorOffset = 7;
      press(h, chords[0]);
      expect(shell.prompt.cursorOffset).toBe(4);
      press(h, chords[1]);
      expect(shell.prompt.cursorOffset).toBe(7);
    },
  },
  "Arrow keys": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "ab\ncd";
      shell.prompt.cursorOffset = 5;
      press(h, chords[0]);
      expect(shell.prompt.cursorOffset).toBe(4);
      press(h, chords[1]);
      expect(shell.prompt.cursorOffset).toBe(5);
      press(h, chords[2]);
      expect(shell.prompt.cursorOffset).toBe(2);
      press(h, chords[3]);
      expect(shell.prompt.cursorOffset).toBe(5);
    },
  },
  "Ctrl+K": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "hello world";
      shell.prompt.cursorOffset = 5;
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("hello");
    },
  },
  "Ctrl+U": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "hello world";
      shell.prompt.cursorOffset = 6;
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("world");
    },
  },
  "Ctrl+W": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "foo bar";
      shell.prompt.cursorOffset = 7;
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("foo ");
    },
  },
  "Alt+D": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      shell.prompt.value = "foo bar";
      shell.prompt.cursorOffset = 0;
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("bar");
    },
  },
  "Ctrl+Y": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      breakKillSequence(h);
      shell.prompt.value = "kill me";
      shell.prompt.cursorOffset = 0;
      press(h, "\x0b"); // Ctrl+K fills the kill ring
      expect(shell.prompt.value).toBe("");
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("kill me");
    },
  },
  "Alt+Y": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      breakKillSequence(h);
      shell.prompt.value = "older";
      shell.prompt.cursorOffset = 0;
      press(h, "\x0b");
      breakKillSequence(h);
      shell.prompt.value = "newer";
      shell.prompt.cursorOffset = 0;
      press(h, "\x0b");
      press(h, "\x19"); // Ctrl+Y yanks the newest kill
      expect(shell.prompt.value).toBe("newer");
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("older");
    },
  },
  "Ctrl+V / Ctrl+P": {
    group: "editing",
    probe: async ({ h, shell, chords }) => {
      for (const [index, chord] of chords.entries()) {
        const attached = attachOnNextPrompt(shell, `clip-${index}`);
        press(h, chord);
        await attached;
      }
      expect(shell.pendingAttachments).toHaveLength(chords.length);
      shell.pendingAttachments = [];
    },
  },
  "Up / Down": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      setSentMessageHistory(shell, ["older", "newer"]);
      shell.prompt.value = "";
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("newer");
      press(h, chords[1]);
      expect(shell.prompt.value).toBe("");
    },
  },
  "Ctrl+Enter / Ctrl+J": {
    group: "editing",
    probe: ({ h, shell, chords }) => {
      for (const chord of chords) {
        if (chord === null) {
          // No byte sequence exists outside kitty, so the claim is checked
          // against the binding table the widget is actually built with.
          expect(PROMPT_KEY_BINDINGS).toContainEqual({
            name: "return",
            ctrl: true,
            action: "newline",
          });
          continue;
        }
        shell.prompt.value = "line";
        shell.prompt.cursorOffset = 4;
        press(h, chord);
        expect(shell.prompt.value).toBe("line\n");
      }
      // The parenthetical in the row's description, held to the same
      // standard. Plain terminals can't report Shift on Enter (bare \r
      // either way — confirmed live, not just assumed), but a terminal that
      // negotiates the kitty keyboard protocol — which this app requests —
      // can, and the widget is built to honor it when it does.
      expect(PROMPT_KEY_BINDINGS).toContainEqual({
        name: "return",
        shift: true,
        action: "newline",
      });
    },
  },

  "Alt+C": {
    group: "surfaces",
    probe: ({ h, shell, chords }) => {
      appendStreamRow(shell, { role: "assistant", text: "copy this" });
      press(h, chords[0]);
      expect(shell.overlayKind).toBe("copy");
      press(h, chords[0]);
      expect(shell.overlayKind).toBeNull();
    },
  },
  "Alt+M": {
    group: "surfaces",
    probe: ({ h, shell, chords }) => {
      let captured = false;
      shell.mouseCapture = {
        get: () => captured,
        set: (enabled) => {
          captured = enabled;
        },
      };
      press(h, chords[0]);
      expect(captured).toBe(true);
      press(h, chords[0]);
      expect(captured).toBe(false);
      shell.mouseCapture = null;
    },
  },
  "Alt+T": {
    group: "surfaces",
    probe: ({ h, shell, chords }) => {
      setChromeZones(shell, { task: [{ label: "a", status: "todo" }] });
      // CL-5847: hidden by default — first press shows, second hides.
      expect(shell.taskBox.visible).toBe(false);
      press(h, chords[0]);
      expect(shell.taskBox.visible).toBe(true);
      press(h, chords[0]);
      expect(shell.taskBox.visible).toBe(false);
    },
  },
  "Alt+O": {
    group: "surfaces",
    probe: ({ h, shell, chords }) => {
      // No session wired: an honest system row, not silence.
      const before = streamRowCount(shell);
      press(h, chords[0]);
      expect(streamRowCount(shell)).toBe(before + 1);
      expect(streamRowAt(shell, before)?.text).toBe("no subagent session to observe");
      expect(shell.observe).toBeNull();

      // Host wires a live session: the same chord enters it for real.
      setPaletteOnObserveRequest(shell, () => ({
        sessionId: "live-1",
        agentId: "explorer",
        description: "map callers",
        lines: [{ role: "assistant", text: "child line" }],
      }));
      press(h, chords[0]);
      expect(shell.observe?.sessionId).toBe("live-1");
      // Leave the way Esc would, so later probes in this shared-shell
      // sequence see the same prompt-focused state they'd get otherwise.
      leaveSubagentObserve(shell);
      setPaletteOnObserveRequest(shell, undefined);
    },
  },
  "Alt+E": {
    group: "surfaces",
    probe: ({ h, shell, chords }) => {
      const at = shell.streamLog.length;
      const body = [[{ text: "detail", fg: "#ffffff" }]];
      appendStreamRow(shell, { role: "tool", text: "a", summary: "sa", detail: body });
      appendStreamRow(shell, { role: "tool", text: "b", summary: "sb", detail: body });
      press(h, chords[0]);
      // Bulk, not newest-only: both rows move together.
      expect(streamRowAt(shell, at)?.expanded).toBe(true);
      expect(streamRowAt(shell, at + 1)?.expanded).toBe(true);
      press(h, chords[0]);
      expect(streamRowAt(shell, at)?.expanded).toBe(false);
      expect(streamRowAt(shell, at + 1)?.expanded).toBe(false);
    },
  },
  Tab: {
    group: "surfaces",
    probe: ({ h, shell, chords }) => {
      shellFocusPrompt(shell);
      press(h, chords[0]);
      expect(focusOwner(shell.focus)).toBe("transcript");
      press(h, chords[0]);
      expect(focusOwner(shell.focus)).toBe("prompt");
    },
  },
  "Shift+Tab": {
    group: "surfaces",
    probe: ({ h, shell }) => {
      let cycles = 0;
      setEffortCycleHandler(shell, () => {
        cycles++;
      });
      shellFocusPrompt(shell);
      const before = focusOwner(shell.focus);
      // Classic terminals often emit CSI Z for Shift+Tab; the harness can also
      // inject name:"tab" with shift:true, which is what the shell handler reads.
      h.pressKey("Tab", { shift: true });
      expect(cycles).toBe(1);
      expect(focusOwner(shell.focus)).toBe(before);
    },
  },
  Esc: {
    group: "surfaces",
    probe: async ({ h, shell, chords }) => {
      setPaletteCatalog(shell, [{ id: "cost", label: "cost" }]);
      shellFocusPrompt(shell);
      shell.prompt.value = "";
      shell.prompt.cursorOffset = 0;
      press(h, "/"); // opens the / command popup, something Esc must close
      expect(shell.overlayKind).toBe("palette");
      press(h, chords[0]);
      await escapeSettles();
      expect(shell.overlayKind).toBeNull();
      shell.prompt.value = "";
    },
  },
  "@": {
    group: "surfaces",
    probe: async ({ h, shell, chords }) => {
      setMentionSuggestionSource(shell, async () => ["src/", "README.md"]);
      shellFocusPrompt(shell);

      shell.prompt.value = "mid";
      shell.prompt.cursorOffset = 3;
      press(h, chords[0]);
      await settle(h);
      expect(shell.overlayKind).toBeNull();

      shell.prompt.value = "";
      shell.prompt.cursorOffset = 0;
      press(h, chords[0]);
      await settle(h);
      expect(shell.overlayKind).toBe("mentions");
      press(h, "\x1b");
      await escapeSettles();
      shell.prompt.value = "";
    },
  },
  "/": {
    group: "surfaces",
    probe: async ({ h, shell, chords }) => {
      setPaletteCatalog(shell, [{ id: "cost", label: "cost" }]);
      shellFocusPrompt(shell);

      shell.prompt.value = "note";
      shell.prompt.cursorOffset = 4;
      press(h, chords[0]);
      expect(isSlashPopupOpen(shell)).toBe(false);

      shell.prompt.value = "";
      shell.prompt.cursorOffset = 0;
      press(h, chords[0]);
      expect(isSlashPopupOpen(shell)).toBe(true);
      press(h, "\x1b");
      await escapeSettles();
      shell.prompt.value = "";
    },
  },

  Enter: {
    group: "session",
    probe: ({ h, shell, chords }) => {
      const sent = recordSubmits(shell);
      setShellRunState(shell, "idle");
      shell.prompt.value = "ship it";
      press(h, chords[0]);
      expect(sent).toEqual([{ text: "ship it", kind: "immediate" }]);
    },
  },
  "Alt+Enter": {
    group: "session",
    probe: ({ h, shell, chords }) => {
      const sent = recordSubmits(shell);
      setShellRunState(shell, "idle");
      shell.prompt.value = "not yet";
      press(h, chords[0]);
      // Idle Alt+Enter is a no-op — follow-up only makes sense mid-run.
      expect(sent).toEqual([]);
      expect(shell.prompt.value).toBe("not yet");

      // Busy: follow-up (kind "queue"), not reinject. Delivered only when
      // the run goes idle; never interrupts.
      setShellRunState(shell, "busy");
      press(h, chords[0]);
      expect(sent).toEqual([{ text: "not yet", kind: "queue" }]);
      expect(shell.prompt.value).toBe("");
      setShellRunState(shell, "idle");
    },
  },
  "Ctrl+C": {
    group: "session",
    probe: ({ h, shell, chords }) => {
      let interrupted = 0;
      let exited = 0;
      setShellBridgeHooks(shell, {
        onSubmit: () => {},
        onInterrupt: () => {
          interrupted++;
        },
        exclusive: true,
      });
      setShellExitHandler(shell, () => {
        exited++;
      });
      setShellRunState(shell, "busy");
      press(h, chords[0]);
      expect(interrupted).toBe(1);
      expect(exited).toBe(0);
      press(h, chords[0]);
      expect(exited).toBe(1);
      setShellRunState(shell, "idle");

      // Bridge-less local interrupt: what an operator sees when a message
      // was queued and they lose patience — it must report the message
      // will still steer, never that it was discarded.
      clearShellBridgeHooks(shell);
      setShellRunState(shell, "busy");
      const rowsBefore = streamRowCount(shell);
      shell.prompt.value = "keep me";
      submitPrompt(shell, "queue");
      applyShellInterrupt(shell);
      expect(shell.pendingQueue).toBe(1);
      expect(shell.session.items[0]!.text).toBe("keep me");
      const notice = shell.streamLog[shell.streamLog.length - 1];
      expect(notice?.text).toBe("1 pending kept");
      expect(notice?.text).not.toContain("discarded");
      // Other probes in this group share one shell — leave both the queue
      // and the transcript as this probe found them.
      shell.session = { ...shell.session, items: [] };
      truncateStreamRows(shell, rowsBefore);
      setShellRunState(shell, "idle");
    },
  },

  "Ctrl+G": {
    group: "session",
    probe: async ({ h, shell, chords }) => {
      clearShellBridgeHooks(shell);
      setShellRunState(shell, "busy");
      shell.prompt.value = "keep";
      submitPrompt(shell, "queue");
      shell.prompt.value = "drop me";
      submitPrompt(shell, "queue");
      expect(shell.pendingQueue).toBe(2);

      press(h, chords[0]);

      expect(shell.pendingQueue).toBe(1);
      expect(shell.session.items[0]!.text).toBe("keep");
      const rows = shell.streamLog.map((row) => row.meta);
      // The retracted message's row is rewritten, not left claiming "queue"
      // as though it will still dispatch (the bug that got the first attempt
      // at this pulled).
      expect(rows).toEqual(["queue", "cancelled"]);

      // The chord's whole job is what lands on screen, not the model alone —
      // assert on the rendered frame, not just streamLog.
      await h.renderOnce();
      const frame = h.captureCharFrame();
      expect(frame).toContain("[cancelled] drop me");
      expect(frame).toContain("keep");

      setShellRunState(shell, "idle");
    },
  },

  "Ctrl+D": {
    group: "host",
    // Probed on a mounted host rather than a bare shell: the row claims a
    // prompt default, which is only true while the host claims no key of its
    // own. Quitting is Ctrl+C twice and nothing else.
    probe: async ({ h, shell, chords, hasExited }) => {
      if (hasExited === undefined) throw new Error("Ctrl+D must be probed on a mounted host");
      shellFocusPrompt(shell);

      shell.prompt.value = "abc";
      shell.prompt.cursorOffset = 0;
      press(h, chords[0]);
      expect(shell.prompt.value).toBe("bc");
      expect(hasExited()).toBe(false);

      shell.prompt.value = "";
      press(h, chords[0]);
      await settle(h);
      expect(hasExited()).toBe(false);
    },
  },
};

/* --------------------------------------------------------------------- */
/* Helpers                                                                 */
/* --------------------------------------------------------------------- */

/**
 * Consecutive kills append to one ring entry, so a probe that wants a fresh
 * entry presses a non-kill chord first (Ctrl+B, cursor motion only).
 */
function breakKillSequence(h: Harness): void {
  press(h, "\x02");
}

function press(h: Harness, bytes: string | null | undefined): void {
  if (bytes === null || bytes === undefined) throw new Error("no bytes to press");
  h.mockInput.pressKey(bytes);
}

/**
 * A lone ESC byte is ambiguous until the terminal proves nothing follows it, so
 * the parser holds it briefly before emitting the key.
 */
function escapeSettles(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

/** Let a keypress that kicks off async work (mention query) reach the shell. */
async function settle(h: Harness): Promise<void> {
  await h.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await h.renderOnce();
}

function attachOnNextPrompt(shell: AppShell, id: string): Promise<void> {
  let done: () => void = () => {};
  const attached = new Promise<void>((resolve) => {
    done = resolve;
  });
  setPromptImageSource(shell, async () => {
    queueMicrotask(done);
    return {
      ok: true,
      attachment: {
        id,
        name: `${id}.png`,
        contentType: "image/png",
        data: new Uint8Array([137, 80, 78, 71]),
        contentHash: `hash-${id}`,
      },
    };
  });
  return attached;
}

function recordSubmits(shell: AppShell): { readonly text: string; readonly kind: string }[] {
  const sent: { text: string; kind: string }[] = [];
  setShellBridgeHooks(shell, {
    onSubmit: (text, kind) => sent.push({ text, kind }),
    onInterrupt: () => {},
    exclusive: true,
  });
  return sent;
}

function rowsIn(group: Group): readonly { keys: string; probe: Probe }[] {
  return SHELL_SHORTCUTS.flatMap((row) => {
    const entry = PROBES[row.keys];
    return entry !== undefined && entry.group === group
      ? [{ keys: row.keys, probe: entry.probe }]
      : [];
  });
}

/** Run every probe in a group against one shell, so one renderer covers many rows. */
async function runGroup(group: Group): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
      });
      try {
        for (const { keys, probe } of rowsIn(group)) {
          shell.prompt.value = "";
          await probe({ h, shell, chords: chordsOf(keys) });
        }
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

/* --------------------------------------------------------------------- */
/* Tests                                                                   */
/* --------------------------------------------------------------------- */

describe("every catalog row is driven against real behavior", () => {
  test("no row is left without a probe", () => {
    const missing = SHELL_SHORTCUTS.filter((row) => PROBES[row.keys] === undefined).map(
      (row) => row.keys,
    );
    expect(missing).toEqual([]);
  });

  test("no probe describes a chord the catalog no longer lists", () => {
    const listed = new Set(SHELL_SHORTCUTS.map((row) => row.keys));
    expect(Object.keys(PROBES).filter((keys) => !listed.has(keys))).toEqual([]);
  });

  test("prompt editing chords", async () => {
    await runGroup("editing");
  });

  test("overlay and focus chords", async () => {
    await runGroup("surfaces");
  });

  test("send, steer and interrupt chords", async () => {
    await runGroup("session");
  });
});

/**
 * The Ctrl+D failure in general form: a row describing a prompt default is only
 * true while the runner host leaves that byte alone. Driven on a real mount,
 * not a bare shell, so a host listener that shadows the prompt fails here.
 */
describe("the runner host does not shadow the prompt bindings the catalog claims", () => {
  const PROMPT_DEFAULT_ROWS = ["Ctrl+B / Ctrl+F", "Alt+B / Alt+F", "Arrow keys"] as const;

  test("prompt defaults survive the host", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost({
      title: "keybindings",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      deliver: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    let exited = false;
    void host.waitUntilExit().then(() => {
      exited = true;
    });
    try {
      for (const keys of PROMPT_DEFAULT_ROWS) {
        const entry = PROBES[keys];
        if (entry === undefined) throw new Error(`no probe for ${keys}`);
        await entry.probe({ h: harness, shell: host.shell, chords: chordsOf(keys) });
      }
      // Ctrl+D is the sharpest case: the host used to claim it to quit.
      const ctrlD = PROBES["Ctrl+D"];
      if (ctrlD === undefined) throw new Error("no probe for Ctrl+D");
      await ctrlD.probe({
        h: harness,
        shell: host.shell,
        chords: chordsOf("Ctrl+D"),
        hasExited: () => exited,
      });
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});

describe("? no longer opens help", () => {
  test("bare ? types a literal character instead of opening the shortcut list", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    try {
      const shell = createAppShell(harness.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
      });
      try {
        shellFocusPrompt(shell);
        shell.prompt.value = "";
        harness.pressKey("?");
        expect(shell.overlayKind).toBeNull();
        expect(shell.prompt.value).toBe("?");

        shellFocusTranscript(shell);
        harness.pressKey("?");
        // No binding claims it with the transcript focused either — help has
        // no chord left at all, only the /help command.
        expect(shell.overlayKind).toBeNull();
      } finally {
        shell.dispose();
      }
    } finally {
      harness.destroy();
    }
  });
});

describe("help stays reachable as a command", () => {
  test("/help still opens the shortcut list", async () => {
    const notifications: string[] = [];
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      try {
        expect(shell.overlayKind).toBeNull();
        const opened = openCommandSurface(shell, "help", {
          notify: (text) => notifications.push(text),
        });
        expect(opened).toBe(true);
        expect(shell.overlayKind).toBe("help");
      } finally {
        shell.dispose();
      }
    });
  });

  test("openHelpOverlay (the /help handler) opens the same overlay the removed ? chord used to", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    try {
      const shell = createAppShell(harness.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      try {
        openHelpOverlay(shell);
        expect(shell.overlayKind).toBe("help");
      } finally {
        shell.dispose();
      }
    } finally {
      harness.destroy();
    }
  });
});
