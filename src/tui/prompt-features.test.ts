/**
 * Integration: prompt-side features wired on the OpenTUI shell —
 * clipboard image attach, text paste, sent-message recall, and @-mention
 * suggestions.
 */
import { describe, expect, test } from "bun:test";

import type { PendingImageAttachment } from "./image-attachments.js";
import { withTestRenderer, type Harness } from "./harness";
import {
  acceptOverlaySelection,
  attachClipboardImage,
  clearPendingAttachments,
  createAppShell,
  moveOverlaySelection,
  noticeText,
  openAtMentionSuggestions,
  setMentionSuggestionSource,
  setPromptImageSource,
  setSentMessageHistory,
  setShellBridgeHooks,
  submitPrompt,
  type AppShell,
  type FlashSchedule,
} from "./shell";
import { RUNTIME_FLASH_MS } from "./runtime-notices";

const CLIP: PendingImageAttachment = {
  id: "clip-1",
  name: "clipboard.png",
  contentType: "image/png",
  data: new Uint8Array([137, 80, 78, 71]),
  contentHash: "hash-a",
};

// A second read of the same clipboard content: distinct id/name/timestamp
// (as a real re-paste would produce) but identical decoded bytes and hash.
const CLIP_SAME_CONTENT: PendingImageAttachment = {
  id: "clip-2",
  name: "clipboard-later.png",
  contentType: "image/png",
  data: new Uint8Array([137, 80, 78, 71]),
  contentHash: "hash-a",
};

const CLIP_OTHER: PendingImageAttachment = {
  id: "clip-3",
  name: "clipboard-other.png",
  contentType: "image/png",
  data: new Uint8Array([1, 2, 3, 4]),
  contentHash: "hash-b",
};

function withShell(
  fn: (shell: AppShell) => Promise<void>,
  opts?: { readonly wireKeys?: boolean; readonly flashSchedule?: FlashSchedule },
): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: opts?.wireKeys ?? true,
        run: "idle",
        ...(opts?.flashSchedule !== undefined ? { flashSchedule: opts.flashSchedule } : {}),
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

describe("image attachments", () => {
  test("attaches a clipboard image and says so on the notice row", async () => {
    await withShell(async (shell) => {
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }));
      expect(await attachClipboardImage(shell)).toBe(true);
      expect(shell.pendingAttachments).toHaveLength(1);
      const notice = noticeText(shell);
      expect(notice).toContain("1 image");
      expect(notice).toContain("attached clipboard.png");
    });
  });

  test("reports the failure reason and attaches nothing", async () => {
    await withShell(async (shell) => {
      setPromptImageSource(shell, async () => ({ ok: false, reason: "no PNG" }));
      expect(await attachClipboardImage(shell)).toBe(false);
      expect(shell.pendingAttachments).toEqual([]);
      expect(shell.statusFlash).toContain("no PNG");
    });
  });

  test("fail / attached / duplicate confirmation flashes expire via flashSchedule", async () => {
    const lapse: (() => void)[] = [];
    const flashSchedule: FlashSchedule = (fn, ms) => {
      expect(ms).toBe(RUNTIME_FLASH_MS);
      lapse.push(fn);
      return () => {};
    };

    await withShell(
      async (shell) => {
        setPromptImageSource(shell, async () => ({ ok: false, reason: "no PNG" }));
        expect(await attachClipboardImage(shell)).toBe(false);
        expect(shell.statusFlash).toContain("no PNG");
        expect(lapse).toHaveLength(1);
        lapse[0]?.();
        expect(shell.statusFlash).toBeNull();
      },
      { flashSchedule },
    );

    lapse.length = 0;
    await withShell(
      async (shell) => {
        setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }));
        expect(await attachClipboardImage(shell)).toBe(true);
        expect(shell.statusFlash).toContain("attached clipboard.png");
        expect(lapse).toHaveLength(1);
        lapse[0]?.();
        expect(shell.statusFlash).toBeNull();

        setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP_SAME_CONTENT }));
        expect(await attachClipboardImage(shell)).toBe(false);
        expect(shell.statusFlash).toContain(`${CLIP.name} is already attached`);
        expect(lapse).toHaveLength(2);
        lapse[1]?.();
        expect(shell.statusFlash).toBeNull();
      },
      { flashSchedule },
    );
  });

  test("quitting mid-read does not attach into the disposed shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        let resolveRead: (r: { ok: true; attachment: PendingImageAttachment }) => void = () => {};
        setPromptImageSource(
          shell,
          () =>
            new Promise((resolve) => {
              resolveRead = resolve;
            }),
        );

        const pending = attachClipboardImage(shell);

        // The operator quits before the clipboard read answers.
        shell.dispose();
        resolveRead({ ok: true, attachment: CLIP });

        expect(await pending).toBe(false);
        expect(shell.pendingAttachments).toEqual([]);
      },
      { width: 80, height: 24 },
    );
  });

  // Raw control bytes, not a synthetic KeyEvent: a binding that never matches
  // what the terminal actually writes looks correct in the catalog and fails
  // silently in use.
  for (const [chord, byte] of [
    ["Ctrl+P", "\x10"],
    ["Ctrl+V", "\x16"],
  ] as const) {
    test(`${chord} attaches through the wired key handler`, async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: true,
            run: "idle",
          });
          try {
            let resolveAttached: () => void = () => {};
            const attached = new Promise<void>((r) => {
              resolveAttached = r;
            });
            setPromptImageSource(shell, async () => {
              queueMicrotask(resolveAttached);
              return { ok: true, attachment: CLIP };
            });
            h.mockInput.pressKey(byte);
            await attached;
            await h.renderOnce();
            expect(shell.pendingAttachments).toHaveLength(1);
            expect(shell.prompt.value).toBe("");
          } finally {
            shell.dispose();
          }
        },
        { width: 80, height: 24 },
      );
    });
  }

  test("re-pasting the same clipboard content does not attach a second copy", async () => {
    await withShell(async (shell) => {
      let calls = 0;
      setPromptImageSource(shell, async () => {
        calls += 1;
        return { ok: true, attachment: calls === 1 ? CLIP : CLIP_SAME_CONTENT };
      });
      expect(await attachClipboardImage(shell)).toBe(true);
      expect(await attachClipboardImage(shell)).toBe(false);
      expect(shell.pendingAttachments).toHaveLength(1);
      expect(shell.pendingAttachments[0]?.id).toBe("clip-1");
      // Names the attachment already sitting in the pending set (CLIP), not
      // the rejected paste (CLIP_SAME_CONTENT) -- the operator never saw the
      // rejected paste's filename, so naming it would read as a bug.
      expect(shell.statusFlash).toContain(`${CLIP.name} is already attached`);
      expect(shell.statusFlash).not.toContain(CLIP_SAME_CONTENT.name);
    });
  });

  test("a genuinely different image still attaches alongside the first", async () => {
    await withShell(async (shell) => {
      let calls = 0;
      setPromptImageSource(shell, async () => {
        calls += 1;
        return { ok: true, attachment: calls === 1 ? CLIP : CLIP_OTHER };
      });
      expect(await attachClipboardImage(shell)).toBe(true);
      expect(await attachClipboardImage(shell)).toBe(true);
      expect(shell.pendingAttachments).toHaveLength(2);
    });
  });

  test("removing all attachments and re-pasting the same content re-attaches it", async () => {
    await withShell(async (shell) => {
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }));
      expect(await attachClipboardImage(shell)).toBe(true);
      clearPendingAttachments(shell);
      expect(await attachClipboardImage(shell)).toBe(true);
      expect(shell.pendingAttachments).toHaveLength(1);
    });
  });

  test("submit hands pending attachments to the bridge and clears them", async () => {
    await withShell(async (shell) => {
      const seen: (readonly PendingImageAttachment[] | undefined)[] = [];
      setShellBridgeHooks(shell, {
        onSubmit: (_text, _kind, attachments) => seen.push(attachments),
        onInterrupt: () => {},
        exclusive: true,
      });
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }));
      await attachClipboardImage(shell);
      shell.prompt.value = "what is this";
      submitPrompt(shell);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(1);
      expect(shell.pendingAttachments).toEqual([]);
    });
  });

  test("an image with no text still submits", async () => {
    await withShell(async (shell) => {
      const texts: string[] = [];
      setShellBridgeHooks(shell, {
        onSubmit: (text) => texts.push(text),
        onInterrupt: () => {},
        exclusive: true,
      });
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }));
      await attachClipboardImage(shell);
      submitPrompt(shell);
      expect(texts).toEqual([""]);
    });
  });

  test("empty Enter still reaches exclusive host for multi-turn cancel", async () => {
    await withShell(async (shell) => {
      const submitted: string[] = [];
      setShellBridgeHooks(shell, {
        onSubmit: (text) => submitted.push(text),
        onInterrupt: () => {},
        exclusive: true,
      });
      shell.prompt.value = "   ";
      submitPrompt(shell);
      expect(submitted).toEqual(["   "]);
    });
  });
});

/**
 * A pasted newline must never reach the bare-return submit binding: that would
 * send half a message. The renderer negotiates bracketed paste (DEC 2004), so
 * a real paste arrives as OpenTUI's own `paste` event rather than as keys —
 * these drive the raw ESC[200~ … ESC[201~ bytes to prove it.
 */
describe("text paste", () => {
  const pasteCase = (label: string, drive: (h: Harness) => Promise<void>, expected: string) => {
    test(label, async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: true,
            run: "idle",
          });
          try {
            const submitted: string[] = [];
            setShellBridgeHooks(shell, {
              onSubmit: (text) => submitted.push(text),
              onInterrupt: () => {},
              exclusive: true,
            });
            setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }));
            shell.prompt.focus();
            await drive(h);
            await h.renderOnce();
            expect(shell.prompt.value).toBe(expected);
            expect(submitted).toEqual([]);
            expect(shell.pendingAttachments).toEqual([]);
          } finally {
            shell.dispose();
          }
        },
        { width: 80, height: 24 },
      );
    });
  };

  pasteCase(
    "single-line paste lands verbatim",
    async (h) => await h.mockInput.pasteBracketedText("hello world"),
    "hello world",
  );

  pasteCase(
    "multi-line paste keeps its newlines and does not submit",
    async (h) => await h.mockInput.pasteBracketedText("first line\nsecond line\nthird line"),
    "first line\nsecond line\nthird line",
  );

  // Terminals normalise pasted line endings differently; CRLF inside a
  // bracketed paste must still be composed text, not a submit.
  pasteCase(
    "a CRLF paste does not submit on the carriage return",
    async (h) => await h.mockInput.pasteBracketedText("first line\r\nsecond line"),
    "first line\nsecond line",
  );

  pasteCase(
    "a paste larger than one stdin chunk arrives intact",
    async (h) => await h.mockInput.pasteBracketedText(`${"x".repeat(4000)}\nend`),
    `${"x".repeat(4000)}\nend`,
  );

  // A terminal that never negotiated DEC 2004 hands a paste to us as plain
  // keystrokes -- CR included -- instead of one `paste` event. Without a
  // burst guard, the bare CR after "line one" would hit the same submit
  // binding a deliberate Enter does, sending the message after its first
  // line instead of composing all three.
  pasteCase(
    "a CRLF paste arriving as raw keystrokes still composes instead of submitting",
    async (h) => await h.mockInput.typeText("line one\r\nline two\r\nline three"),
    "line one\nline two\nline three",
  );
});

describe("un-bracketed paste vs. deliberate Enter", () => {
  test("Ctrl+J then Enter still sends -- a newline chord followed by a real Enter is not a paste", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          const submitted: string[] = [];
          setShellBridgeHooks(shell, {
            onSubmit: (text) => submitted.push(text),
            onInterrupt: () => {},
            exclusive: true,
          });
          shell.prompt.focus();
          shell.prompt.value = "first";
          h.mockInput.pressKey("\n");
          h.mockInput.pressKey("\r");
          await h.renderOnce();
          expect(submitted).toEqual(["first\n"]);
          expect(shell.prompt.value).toBe("");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  // The false-positive direction: once this terminal has proven it negotiates
  // DEC 2004 by firing one real bracketed paste, the raw-keystroke fallback
  // must retire for the rest of the session -- otherwise a fast typist's
  // genuine Enter risks being read as paste forever, on every keystroke, on
  // every terminal, most of which never needed the fallback at all.
  //
  // This cannot be distinguished from actual paste by timing alone: the
  // harness dispatches keys synchronously, so a "fast typist" and a "paste
  // replay" produce the identical zero-elapsed-time shape. The capability
  // gate is what makes the distinction possible -- this test exercises that
  // gate, not a timing threshold.
  test("a keystroke burst after a real paste no longer triggers the CRLF fallback", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          const submitted: string[] = [];
          setShellBridgeHooks(shell, {
            onSubmit: (text) => submitted.push(text),
            onInterrupt: () => {},
            exclusive: true,
          });
          shell.prompt.focus();
          await h.mockInput.pasteBracketedText("proves DEC 2004");
          shell.prompt.value = "";

          await h.mockInput.typeText("hi\r");
          await h.renderOnce();

          expect(submitted).toEqual(["hi"]);
          expect(shell.prompt.value).toBe("");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("sent-message recall", () => {
  test("Up recalls the newest sent message, Down returns the draft", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          setSentMessageHistory(shell, ["first prompt", "second prompt"]);
          shell.prompt.value = "draft";
          shell.prompt.cursorOffset = 0;

          h.pressKey("ARROW_UP");
          await h.renderOnce();
          expect(shell.prompt.value).toBe("second prompt");

          shell.prompt.cursorOffset = 0;
          h.pressKey("ARROW_UP");
          await h.renderOnce();
          expect(shell.prompt.value).toBe("first prompt");

          h.pressKey("ARROW_DOWN");
          await h.renderOnce();
          expect(shell.prompt.value).toBe("second prompt");

          h.pressKey("ARROW_DOWN");
          await h.renderOnce();
          expect(shell.prompt.value).toBe("draft");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("submitting records the message for later recall", async () => {
    await withShell(async (shell) => {
      setShellBridgeHooks(shell, {
        onSubmit: () => {},
        onInterrupt: () => {},
        exclusive: true,
      });
      shell.prompt.value = "remember me";
      submitPrompt(shell);
      expect(shell.sentHistory.sent).toEqual(["remember me"]);
    });
  });
});

describe("@-mention suggestions", () => {
  test("opens the mentions overlay for the token under the cursor", async () => {
    await withShell(async (shell) => {
      // The popup lists the directory portion and narrows the listing itself,
      // so the source is asked for `src/`, not the whole typed token.
      setMentionSuggestionSource(shell, async (prefix) => {
        expect(prefix).toBe("src/");
        return ["src/tui/", "src/telemetry/", "src/config/"];
      });
      shell.prompt.value = "read @src/t";
      shell.prompt.cursorOffset = shell.prompt.value.length;

      expect(await openAtMentionSuggestions(shell)).toBe(true);
      expect(shell.overlayKind).toBe("mentions");
      expect(shell.overlayItems).toEqual(["src/tui/", "src/telemetry/"]);
    });
  });

  test("accepting a file splices it into the prompt", async () => {
    await withShell(async (shell) => {
      setMentionSuggestionSource(shell, async () => ["AGENTS.md", "README.md"]);
      shell.prompt.value = "read @";
      shell.prompt.cursorOffset = 6;

      await openAtMentionSuggestions(shell);
      moveOverlaySelection(shell, 1);
      acceptOverlaySelection(shell);
      expect(shell.prompt.value).toBe("read @README.md");
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("does nothing when the cursor is not inside an @token", async () => {
    await withShell(async (shell) => {
      setMentionSuggestionSource(shell, async () => ["AGENTS.md"]);
      shell.prompt.value = "no mention here";
      shell.prompt.cursorOffset = shell.prompt.value.length;
      expect(await openAtMentionSuggestions(shell)).toBe(false);
      expect(shell.overlayKind).toBeNull();
    });
  });

  test("typing @ at a word boundary opens the overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        });
        try {
          let resolveOpened: () => void = () => {};
          const opened = new Promise<void>((r) => {
            resolveOpened = r;
          });
          setMentionSuggestionSource(shell, async () => {
            queueMicrotask(resolveOpened);
            return ["AGENTS.md"];
          });
          h.pressKey("@");
          await opened;
          await h.renderOnce();
          expect(shell.prompt.value).toBe("@");
          expect(shell.overlayKind).toBe("mentions");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
