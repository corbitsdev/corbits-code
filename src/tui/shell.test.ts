/**
 * Integration: app shell product skin — sticky, queue/steer/interrupt.
 */
import { describe, expect, test } from "bun:test";
import { defined } from "../testkit/defined.js";
import { IDLE_TRANSCRIPT_FLOOR } from "./geometry/index";
import { focusOwner, scrollLease } from "./focus/index";
import { withTestRenderer } from "./harness";
import { paintStreamRow } from "./stream";
import {
  appendStreamRow,
  appendTranscript,
  noticeText,
  setPendingQueue,
  shellFocusPrompt,
  shellFocusTranscript,
  toggleShellFocus,
} from "./shell/chrome";
import { createAppShell } from "./shell/index";
import {
  isTranscriptFollowing,
  shellInternals,
  stickyMode,
} from "./shell/internals";
import {
  applyShellCancelLast,
  interruptShell,
  submitPrompt,
} from "./shell/prompt";
import { transcriptRowLayout } from "./shell/transcript";

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
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
            IDLE_TRANSCRIPT_FLOOR,
          );
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
          expect(Math.abs(shell.transcript.scrollTop - pinnedTop)).toBeLessThan(
            2,
          );
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

          shell.transcript.scrollTop =
            shell.transcript.scrollHeight - shell.transcript.height;
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
          const promptX = defined(rows[borderRow]).indexOf("╭") + 2;
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

  test("pending queue lists in the column above the prompt", async () => {
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
          const frame = h.captureCharFrame();
          // setPendingQueue pads with kind "queue" → follow-up rows.
          expect(frame).toContain("follow-up  pad-1");
          expect(frame).toContain("follow-up  pad-3");
          expect(shell.streamLog).toHaveLength(0);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("↑/↓ walk the column; the selected row paints ▸", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          setPendingQueue(shell, 3);
          await h.renderOnce();
          // ↑ at the buffer's top edge selects the newest held item.
          h.mockInput.pressKey("\x1b[A");
          await h.renderOnce();
          expect(shellInternals(shell)?.pendingSelId).toBe(
            shell.session.items[2]?.id,
          );
          expect(h.captureCharFrame()).toContain("▸ follow-up  pad-3");
          // ↑ walks up the column.
          h.mockInput.pressKey("\x1b[A");
          await h.renderOnce();
          expect(h.captureCharFrame()).toContain("▸ follow-up  pad-2");
          // ↓ past the last row hands the key back to the prompt.
          h.mockInput.pressKey("\x1b[B");
          h.mockInput.pressKey("\x1b[B");
          await h.renderOnce();
          expect(shellInternals(shell)?.pendingSelId).toBeNull();
          expect(h.captureCharFrame()).not.toContain("▸");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Enter without a deliver hook pops the row back for editing", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          setPendingQueue(shell, 1);
          await h.renderOnce();
          h.mockInput.pressKey("\x1b[A");
          await h.renderOnce();
          h.pressKey("Enter");
          await h.renderOnce();
          expect(shell.session.items).toHaveLength(0);
          expect(shell.prompt.value).toBe("pad-1");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Esc ends the selection and leaves the queue alone", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          setPendingQueue(shell, 2);
          await h.renderOnce();
          h.mockInput.pressKey("\x1b[A");
          await h.renderOnce();
          // ESC needs disambiguation delay on the mock stdin path.
          h.pressKey("Escape");
          await new Promise((r) => setTimeout(r, 60));
          await h.renderOnce();
          expect(shellInternals(shell)?.pendingSelId).toBeNull();
          expect(shell.session.items).toHaveLength(2);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Ctrl+G pops the selected row, not the newest", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          setPendingQueue(shell, 2);
          await h.renderOnce();
          // ↑ selects the newest; ↑ again walks up to the older row.
          h.mockInput.pressKey("\x1b[A");
          h.mockInput.pressKey("\x1b[A");
          await h.renderOnce();
          expect(shellInternals(shell)?.pendingSelId).toBe(
            shell.session.items[0]?.id,
          );
          h.pressKey("g", { ctrl: true });
          await h.renderOnce();
          expect(shell.session.items.map((i) => i.text)).toEqual(["pad-2"]);
          expect(shell.prompt.value).toBe("pad-1");
          expect(shellInternals(shell)?.pendingSelId).toBeNull();
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("a prompt paste ends the selection instead of editing under it", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        });
        try {
          setPendingQueue(shell, 1);
          await h.renderOnce();
          h.mockInput.pressKey("\x1b[A");
          await h.renderOnce();
          expect(shellInternals(shell)?.pendingSelId).not.toBeNull();
          await h.mockInput.pasteBracketedText("pasted");
          await h.renderOnce();
          expect(shellInternals(shell)?.pendingSelId).toBeNull();
          expect(shell.prompt.value).toBe("pasted");
          expect(shell.session.items).toHaveLength(1);
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
          // Assistant rows are markdown; their blocks highlight asynchronously,
          // so poll for the painted body instead of a fixed wait.
          const deadline = Date.now() + 2_000;
          let frame = "";
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await h.renderOnce();
            frame = h.captureCharFrame();
            if (frame.includes("hi there") || Date.now() >= deadline) break;
          }
          // Sticky follows the tail — the last rows stay in view.
          expect(frame).toContain("hi there");
          expect(frame).toContain("bash");
          // One agent is answering, so no row spends columns naming it.
          const inkRows = frame
            .split("\n")
            .filter((row) => row.trim().length > 0);
          expect(inkRows.filter((row) => row.includes("● agent"))).toHaveLength(
            0,
          );
          expect(inkRows.filter((row) => row.includes(" tool "))).toHaveLength(
            0,
          );
          // User row content is in the scroll buffer (pure paint covered in stream.test).
          expect(
            paintStreamRow(
              { role: "user", text: "hello world" },
              transcriptRowLayout(shell),
            ).content,
          ).toContain("hello world");
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
          expect(defined(shell.session.items[0]).kind).toBe("queue");
          expect(shell.prompt.value).toBe("");
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("follow-up  queue me");
          expect(shell.streamLog).toHaveLength(0);
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
          expect(defined(shell.session.items[0]).kind).toBe("steer");
          await h.renderOnce();
          await h.renderOnce();
          const frame = h.captureCharFrame();
          expect(frame).toContain("steer      steer me");
          expect(frame).not.toContain("will steer next");
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

  test("Ctrl+G pops a steered message the same way", async () => {
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
          expect(defined(shell.session.items[0]).kind).toBe("steer");

          applyShellCancelLast(shell);

          expect(shell.pendingQueue).toBe(0);
          expect(shell.session.items).toHaveLength(0);
          expect(shell.prompt.value).toBe("steer me now");
          expect(shell.streamLog).toHaveLength(0);

          await h.renderOnce();
          expect(h.captureCharFrame()).not.toContain("cancelled");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("prompt editing chords", () => {
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
