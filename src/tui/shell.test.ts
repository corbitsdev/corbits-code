/**
 * Integration: app shell product skin — sticky, queue/steer/interrupt, overlay Esc.
 */
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { IDLE_TRANSCRIPT_FLOOR } from "./geometry/index";
import { focusOwner, scrollLease } from "./focus/index";
import { createListViewport, moveActive, visibleSlice } from "./list-viewport";
import { withTestRenderer } from "./harness";
import { paintStreamRow } from "./stream";
import {
  appendStreamRow,
  appendTranscript,
  applyShellCancelLast,
  closeInsetOverlay,
  createAppShell,
  interruptShell,
  isTranscriptFollowing,
  noticeText,
  openInsetOverlay,
  setPendingQueue,
  shellFocusPrompt,
  shellFocusTranscript,
  stickyMode,
  submitPrompt,
  toggleShellFocus,
  transcriptRowLayout,
} from "./shell";

/** The transient notice row sits directly above the prompt box's top rule. */
function noticeRow(frame: string): string {
  const rows = frame.split("\n");
  const top = rows.findIndex((r) => r.includes("╭"));
  return top > 0 ? (rows[top - 1] ?? "") : "";
}

describe("createAppShell", () => {
  test("builds transcript / prompt / notice with floor geometry", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          title: "test",
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          expect(shell.transcript).toBeDefined();
          expect(shell.prompt).toBeDefined();
          expect(shell.notice).toBeDefined();
          expect(shell.promptTopRule).toBeDefined();
          expect(shell.promptBottomRule).toBeDefined();
          expect(shell.transcript.stickyScroll).toBe(true);
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
          expect(focusOwner(shell.focus)).toBe("prompt");
          expect(scrollLease(shell.focus)).toBe("transcript");
          await h.renderOnce();
          const frame = h.captureCharFrame();
          // The session name is not chrome; the brand lockup is.
          expect(frame).toContain("corbits code");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("append follows tail while sticky at bottom", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          for (let i = 0; i < 40; i++) {
            appendTranscript(shell, `line-${i}`);
          }
          await h.renderOnce();
          await h.renderOnce();
          expect(shell.lineCount).toBe(40);
          expect(isTranscriptFollowing(shell)).toBe(true);
          expect(stickyMode(shell)).toBe("FOLLOW");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("scroll up pins; append does not yank viewport", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          for (let i = 0; i < 50; i++) {
            appendTranscript(shell, `seed-${i}`);
          }
          await h.renderOnce();
          expect(isTranscriptFollowing(shell)).toBe(true);

          shell.transcript.scrollTop = 0;
          await h.renderOnce();
          expect(isTranscriptFollowing(shell)).toBe(false);
          expect(stickyMode(shell)).toBe("PINNED");
          const pinnedTop = shell.transcript.scrollTop;

          appendTranscript(shell, "after-pin");
          await h.renderOnce();
          expect(isTranscriptFollowing(shell)).toBe(false);
          expect(Math.abs(shell.transcript.scrollTop - pinnedTop)).toBeLessThan(2);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("the notice says pinned only while the tail is off screen", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          for (let i = 0; i < 50; i++) {
            appendStreamRow(shell, { role: "system", text: `seed-${i}` });
          }
          await h.renderOnce();
          // Following the tail is the default state and says nothing.
          expect(noticeText(shell)).not.toContain("pinned");

          shell.transcript.scrollTop = 0;
          await h.renderOnce();
          expect(noticeText(shell)).toContain("pinned");

          shell.transcript.scrollTop = shell.transcript.scrollHeight - shell.transcript.height;
          await h.renderOnce();
          expect(noticeText(shell)).not.toContain("pinned");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("wheel scroll landing on the prompt moves the transcript, not the prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          for (let i = 0; i < 50; i++) {
            appendTranscript(shell, `seed-${i}`);
          }
          await h.renderOnce();
          await h.renderOnce();
          expect(isTranscriptFollowing(shell)).toBe(true);
          const followingTop = shell.transcript.scrollTop;

          // Locate the prompt's interior on screen and scroll through the
          // renderer's real SGR-mouse parse + hit-test dispatch, the same
          // path a live terminal drives — not a direct method call, which
          // would pass even if the renderer never routed the event here.
          const rows = h.captureCharFrame().split("\n");
          const borderRow = rows.findIndex((r) => r.includes("╭"));
          const promptX = rows[borderRow]!.indexOf("╭") + 2;
          const promptY = borderRow + 1;

          for (let i = 0; i < 5; i++) {
            await h.mockMouse.scroll(promptX, promptY, "up");
          }
          await h.renderOnce();

          // The wheel event landed on the prompt, but the transcript moved
          // and pinned — the prompt's own (empty) buffer never scrolled.
          expect(shell.transcript.scrollTop).toBeLessThan(followingTop);
          expect(isTranscriptFollowing(shell)).toBe(false);
          expect(stickyMode(shell)).toBe("PINNED");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("focus lease: prompt vs transcript", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          expect(focusOwner(shell.focus)).toBe("prompt");
          shellFocusTranscript(shell);
          expect(focusOwner(shell.focus)).toBe("transcript");
          shellFocusPrompt(shell);
          expect(focusOwner(shell.focus)).toBe("prompt");
          toggleShellFocus(shell);
          expect(focusOwner(shell.focus)).toBe("transcript");
          await h.renderOnce();
          // Focus is a lease, not chrome: nothing on screen announces it.
          expect(h.captureCharFrame()).not.toContain("tab prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Tab key toggles shell focus when wireKeys enabled", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          expect(focusOwner(shell.focus)).toBe("prompt");
          h.pressKey("Tab");
          await h.renderOnce();
          expect(focusOwner(shell.focus)).toBe("transcript");
          h.pressKey("Tab");
          await h.renderOnce();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Enter / Alt+Enter / Ctrl+C key shapes on shell renderer", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 60, rows: 20 },
        wireKeys: false,
      });
      try {
        const captured: KeyEvent[] = [];
        h.renderer.keyInput.on("keypress", (key: KeyEvent) => {
          captured.push(key);
        });

        h.pressKey("Enter");
        await h.renderOnce();
        const enter = captured.at(-1)!;
        expect(enter.name === "return" || enter.name === "enter").toBe(true);
        expect(enter.ctrl).toBe(false);
        expect(enter.meta).toBe(false);

        h.pressKey("Alt+Enter");
        await h.renderOnce();
        const alt = captured.at(-1)!;
        expect(alt.name === "return" || alt.name === "enter").toBe(true);
        expect(alt.meta === true || alt.option === true).toBe(true);

        h.pressKey("Ctrl+C");
        await h.renderOnce();
        const ctrlC = captured.at(-1)!;
        expect(ctrlC.name).toBe("c");
        expect(ctrlC.ctrl).toBe(true);
      } finally {
        shell.dispose();
      }
    });
  });

  test("pending queue badge paints in status", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          setPendingQueue(shell, 3);
          expect(shell.pendingQueue).toBe(3);
          await h.renderOnce();
          // setPendingQueue pads with kind "queue" → follow-up badge.
          expect(h.captureCharFrame()).toContain("follow-up 3");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("product skin: stream + queue + overlay", () => {
  test("transcript rows carry no line-number gutter", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "tool", text: "ok", meta: "bash" });
          appendStreamRow(shell, { role: "user", text: "hello world" });
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("hello world");
          expect(frame).not.toMatch(/000[12]/);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("stream rows paint each voice in its own place", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          appendStreamRow(shell, { role: "user", text: "hello world" });
          appendStreamRow(shell, { role: "assistant", text: "hi there" });
          appendStreamRow(shell, {
            role: "tool",
            text: "ok",
            meta: "bash",
          });
          expect(shell.lineCount).toBe(3);
          // Assistant rows are markdown; their blocks highlight asynchronously.
          await new Promise((resolve) => setTimeout(resolve, 250));
          await h.renderOnce();
          const frame = h.captureCharFrame();
          // Sticky follows the tail — the last rows stay in view.
          expect(frame).toContain("hi there");
          expect(frame).toContain("bash");
          // One agent is answering, so no row spends columns naming it.
          const inkRows = frame.split("\n").filter((row) => row.trim().length > 0);
          expect(inkRows.filter((row) => row.includes("● agent"))).toHaveLength(0);
          expect(inkRows.filter((row) => row.includes(" tool "))).toHaveLength(0);
          // User row content is in the scroll buffer (pure paint covered in stream.test).
          expect(
            paintStreamRow({ role: "user", text: "hello world" }, transcriptRowLayout(shell))
              .content,
          ).toContain("hello world");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("the box's borders carry the chrome, with no keys strip", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("corbits code");
          expect(frame).not.toContain("/ commands");
          expect(frame).not.toContain("@ files");
          // Both rules close: the metadata is inside the frame, not beside it.
          expect(frame).toContain("╮");
          expect(frame).toContain("╯");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("busy follow-up enqueue paints follow-up badge", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        try {
          shell.prompt.value = "queue me";
          submitPrompt(shell, "queue");
          expect(shell.pendingQueue).toBe(1);
          expect(shell.session.items[0]!.kind).toBe("queue");
          expect(shell.prompt.value).toBe("");
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("follow-up 1");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("busy soft-steer paints steer badge", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        try {
          shell.prompt.value = "steer me";
          submitPrompt(shell, "steer");
          expect(shell.pendingQueue).toBe(1);
          expect(shell.session.items[0]!.kind).toBe("steer");
          await h.renderOnce();
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("will steer next");
          expect(frame).toContain("steer 1");
          expect(frame).not.toContain("follow-up");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+C interrupt keeps pending + sets flash", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        try {
          shell.prompt.value = "a";
          submitPrompt(shell, "queue");
          shell.prompt.value = "b";
          submitPrompt(shell, "steer");
          expect(shell.pendingQueue).toBe(2);
          interruptShell(shell);
          expect(shell.pendingQueue).toBe(2);
          expect(shell.session.interruptFlash).toBe(true);
          expect(shell.session.run).toBe("idle");
          await h.renderOnce();
          const interruptRow = shell.streamLog[shell.streamLog.length - 1];
          expect(interruptRow?.text).toBe("2 pending kept");
          const row = noticeRow(h.captureCharFrame());
          expect(row).not.toContain("interrupt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+G cancels the last queued message and the screen shows it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        try {
          shell.prompt.value = "keep this one";
          submitPrompt(shell, "queue");
          shell.prompt.value = "oops wrong message";
          submitPrompt(shell, "queue");
          expect(shell.pendingQueue).toBe(2);

          const before = shell.streamLog.map((row) => ({
            text: row.text,
            meta: row.meta,
            cancelled: row.cancelled,
          }));
          expect(before).toEqual([
            { text: "keep this one", meta: "queue", cancelled: undefined },
            { text: "oops wrong message", meta: "queue", cancelled: undefined },
          ]);
          await h.renderOnce();
          const frameBefore = h.captureCharFrame();
          expect(frameBefore).toContain("keep this one");
          expect(frameBefore).toContain("oops wrong message");
          expect(frameBefore).not.toContain("[cancelled]");

          applyShellCancelLast(shell);

          expect(shell.pendingQueue).toBe(1);
          expect(shell.session.items[0]!.text).toBe("keep this one");

          const after = shell.streamLog.map((row) => ({
            text: row.text,
            meta: row.meta,
            cancelled: row.cancelled,
          }));
          // The stored text is untouched — the cancel is a flag the paint
          // layer reads, not a rewrite of what the operator typed.
          expect(after).toEqual([
            { text: "keep this one", meta: "queue", cancelled: undefined },
            { text: "oops wrong message", meta: "cancelled", cancelled: true },
          ]);

          // The screen, not just the model, is asserted on: this is exactly
          // what the first attempt at this issue got wrong (the row read
          // back unchanged from streamLog while the model looked cancelled).
          await h.renderOnce();
          const frameAfter = h.captureCharFrame();
          expect(frameAfter).toContain("[cancelled] oops wrong message");
          expect(frameAfter).toContain("keep this one");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+G cancels a steered message the same way", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        try {
          shell.prompt.value = "steer me now";
          submitPrompt(shell, "steer");
          expect(shell.pendingQueue).toBe(1);
          expect(shell.session.items[0]!.kind).toBe("steer");

          applyShellCancelLast(shell);

          expect(shell.pendingQueue).toBe(0);
          expect(shell.session.items).toHaveLength(0);
          expect(shell.streamLog[0]?.cancelled).toBe(true);
          expect(shell.streamLog[0]?.meta).toBe("cancelled");

          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("[cancelled] steer me now");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("inset overlay opens; Esc restores prompt focus", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          expect(focusOwner(shell.focus)).toBe("prompt");
          openInsetOverlay(shell);
          expect(shell.overlayList).not.toBeNull();
          expect(focusOwner(shell.focus)).toBe("overlay");
          expect(shell.layout.overlayMode).toBe("inset");
          expect(shell.overlayHost.visible).toBe(true);
          await h.renderOnce();
          const openFrame = h.captureCharFrame();
          expect(openFrame).toContain("permission");
          expect(openFrame).toContain("Allow bash");

          closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
          expect(shell.layout.overlayMode).toBe("closed");
          await h.renderOnce();
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Esc key closes overlay via wireKeys", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          openInsetOverlay(shell);
          expect(focusOwner(shell.focus)).toBe("overlay");
          // ESC needs disambiguation delay on the mock stdin path.
          h.pressKey("Escape");
          await new Promise((r) => setTimeout(r, 60));
          await h.renderOnce();
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("80x24 idle transcript floor holds with closed overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
          openInsetOverlay(shell);
          // Inset may shrink transcript but still uses resolver floors.
          expect(shell.layout.overlayHeight).toBeGreaterThan(0);
          closeInsetOverlay(shell);
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(IDLE_TRANSCRIPT_FLOOR);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("prompt editing chords", () => {
  test("Ctrl+K kills to end of prompt, Ctrl+Y yanks it back", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "hello world";
          shell.prompt.cursorOffset = 5;
          h.pressKey("k", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("hello");

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("hello world");
          expect(shell.prompt.cursorOffset).toBe(11);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+U kills to start of prompt (backward)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "hello world";
          shell.prompt.cursorOffset = 6;
          h.pressKey("u", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("world");
          expect(shell.prompt.cursorOffset).toBe(0);

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("hello world");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+W kills the previous word", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "hello world";
          shell.prompt.cursorOffset = 11;
          h.pressKey("w", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("hello ");

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("hello world");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Alt+D kills the next word", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "hello world";
          shell.prompt.cursorOffset = 0;
          h.pressKey("d", { meta: true });
          await h.renderOnce();
          // The native deleteWordForward consumes the trailing separator too.
          expect(shell.prompt.value).toBe("world");

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("hello world");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a no-op Ctrl+K (already at end) does not clobber the prior kill", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "one two three";
          shell.prompt.cursorOffset = 3;
          h.pressKey("k", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("one");

          // Cursor is already at the end of the buffer, so this Ctrl+K kills
          // nothing — it must not overwrite the ring with an empty entry.
          h.pressKey("k", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("one");

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("one two three");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Alt+Y rotates the yank to the next-older kill", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "first second";
          shell.prompt.cursorOffset = 12;
          h.pressKey("w", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("first ");

          // A non-kill keystroke breaks accumulation so the next kill lands
          // in a fresh ring entry instead of merging with this one.
          h.pressKey("ARROW_LEFT");
          await h.renderOnce();
          shell.prompt.cursorOffset = 0;

          h.pressKey("k", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("");

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("first ");

          h.pressKey("y", { meta: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("second");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("typing between kills breaks accumulation: a later Ctrl+K starts a fresh entry", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          shell.prompt.value = "one two";
          shell.prompt.cursorOffset = 3;
          h.pressKey("k", { ctrl: true });
          await h.renderOnce();
          expect(shell.prompt.value).toBe("one");

          h.pressKey("x");
          await h.renderOnce();
          expect(shell.prompt.value).toBe("onex");

          h.pressKey("Backspace");
          await h.renderOnce();
          expect(shell.prompt.value).toBe("one");

          h.pressKey("y", { ctrl: true });
          await h.renderOnce();
          // The kill ring still has " two" from the original Ctrl+K — typing
          // and backspacing in between must not have merged into it.
          expect(shell.prompt.value).toBe("one two");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("list kit + overlay focus simulation", () => {
  test("list viewport keep-active-visible works as overlay consumer", () => {
    let list = createListViewport({ count: 40, height: 8, activeIndex: 0 });
    list = moveActive(list, 20);
    const slice = visibleSlice(list);
    expect(slice.activeIndex).toBe(20);
    expect(slice.start).toBeLessThanOrEqual(20);
    expect(slice.end).toBeGreaterThan(20);
    expect(20 >= slice.start && 20 < slice.end).toBe(true);
  });
});
