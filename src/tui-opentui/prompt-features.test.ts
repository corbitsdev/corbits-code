/**
 * Integration: prompt-side features wired on the OpenTUI shell —
 * clipboard image attach, text paste, sent-message recall, and @-mention
 * suggestions.
 */
import { describe, expect, test } from "bun:test"

import type { PendingImageAttachment } from "../tui/image-attachments.js"
import { withTestRenderer, type Harness } from "./harness"
import {
  acceptOverlaySelection,
  attachClipboardImage,
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
} from "./shell"

const CLIP: PendingImageAttachment = {
  id: "clip-1",
  name: "clipboard.png",
  contentType: "image/png",
  data: new Uint8Array([137, 80, 78, 71]),
}

function withShell(
  fn: (shell: AppShell) => Promise<void>,
  opts?: { readonly wireKeys?: boolean },
): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: opts?.wireKeys ?? true,
        run: "idle",
      })
      try {
        await fn(shell)
      } finally {
        shell.dispose()
      }
    },
    { width: 80, height: 24 },
  )
}

describe("image attachments", () => {
  test("attaches a clipboard image and says so on the notice row", async () => {
    await withShell(async (shell) => {
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }))
      expect(await attachClipboardImage(shell)).toBe(true)
      expect(shell.pendingAttachments).toHaveLength(1)
      const notice = noticeText(shell)
      expect(notice).toContain("1 image")
      expect(notice).toContain("attached clipboard.png")
    })
  })

  test("reports the failure reason and attaches nothing", async () => {
    await withShell(async (shell) => {
      setPromptImageSource(shell, async () => ({ ok: false, reason: "no PNG" }))
      expect(await attachClipboardImage(shell)).toBe(false)
      expect(shell.pendingAttachments).toEqual([])
      expect(shell.statusFlash).toContain("no PNG")
    })
  })

  test("quitting mid-read does not attach into the disposed shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        })
        let resolveRead: (r: { ok: true; attachment: PendingImageAttachment }) => void =
          () => {}
        setPromptImageSource(
          shell,
          () =>
            new Promise((resolve) => {
              resolveRead = resolve
            }),
        )

        const pending = attachClipboardImage(shell)

        // The operator quits before the clipboard read answers.
        shell.dispose()
        resolveRead({ ok: true, attachment: CLIP })

        expect(await pending).toBe(false)
        expect(shell.pendingAttachments).toEqual([])
      },
      { width: 80, height: 24 },
    )
  })

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
          })
          try {
            let resolveAttached: () => void = () => {}
            const attached = new Promise<void>((r) => {
              resolveAttached = r
            })
            setPromptImageSource(shell, async () => {
              queueMicrotask(resolveAttached)
              return { ok: true, attachment: CLIP }
            })
            h.mockInput.pressKey(byte)
            await attached
            await h.renderOnce()
            expect(shell.pendingAttachments).toHaveLength(1)
            expect(shell.prompt.value).toBe("")
          } finally {
            shell.dispose()
          }
        },
        { width: 80, height: 24 },
      )
    })
  }

  test("submit hands pending attachments to the bridge and clears them", async () => {
    await withShell(async (shell) => {
      const seen: Array<readonly PendingImageAttachment[] | undefined> = []
      setShellBridgeHooks(shell, {
        onSubmit: (_text, _kind, attachments) => seen.push(attachments),
        onInterrupt: () => {},
        exclusive: true,
      })
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }))
      await attachClipboardImage(shell)
      shell.prompt.value = "what is this"
      submitPrompt(shell)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toHaveLength(1)
      expect(shell.pendingAttachments).toEqual([])
    })
  })

  test("an image with no text still submits", async () => {
    await withShell(async (shell) => {
      const texts: string[] = []
      setShellBridgeHooks(shell, {
        onSubmit: (text) => texts.push(text),
        onInterrupt: () => {},
        exclusive: true,
      })
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }))
      await attachClipboardImage(shell)
      submitPrompt(shell)
      expect(texts).toEqual([""])
    })
  })
})

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
          })
          try {
            const submitted: string[] = []
            setShellBridgeHooks(shell, {
              onSubmit: (text) => submitted.push(text),
              onInterrupt: () => {},
              exclusive: true,
            })
            setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }))
            shell.prompt.focus()
            await drive(h)
            await h.renderOnce()
            expect(shell.prompt.value).toBe(expected)
            expect(submitted).toEqual([])
            expect(shell.pendingAttachments).toEqual([])
          } finally {
            shell.dispose()
          }
        },
        { width: 80, height: 24 },
      )
    })
  }

  pasteCase(
    "single-line paste lands verbatim",
    async (h) => await h.mockInput.pasteBracketedText("hello world"),
    "hello world",
  )

  pasteCase(
    "multi-line paste keeps its newlines and does not submit",
    async (h) => await h.mockInput.pasteBracketedText("first line\nsecond line\nthird line"),
    "first line\nsecond line\nthird line",
  )

  // Terminals normalise pasted line endings differently; CRLF inside a
  // bracketed paste must still be composed text, not a submit.
  pasteCase(
    "a CRLF paste does not submit on the carriage return",
    async (h) => await h.mockInput.pasteBracketedText("first line\r\nsecond line"),
    "first line\nsecond line",
  )

  pasteCase(
    "a paste larger than one stdin chunk arrives intact",
    async (h) => await h.mockInput.pasteBracketedText(`${"x".repeat(4000)}\nend`),
    `${"x".repeat(4000)}\nend`,
  )

  // A terminal that never negotiated DEC 2004 hands a paste to us as plain
  // keystrokes -- CR included -- instead of one `paste` event. Without a
  // burst guard, the bare CR after "line one" would hit the same submit
  // binding a deliberate Enter does, sending the message after its first
  // line instead of composing all three.
  pasteCase(
    "a CRLF paste arriving as raw keystrokes still composes instead of submitting",
    async (h) => await h.mockInput.typeText("line one\r\nline two\r\nline three"),
    "line one\nline two\nline three",
  )
})

describe("un-bracketed paste vs. deliberate Enter", () => {
  test("Ctrl+J then Enter still sends -- a newline chord followed by a real Enter is not a paste", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        })
        try {
          const submitted: string[] = []
          setShellBridgeHooks(shell, {
            onSubmit: (text) => submitted.push(text),
            onInterrupt: () => {},
            exclusive: true,
          })
          shell.prompt.focus()
          shell.prompt.value = "first"
          h.mockInput.pressKey("\n")
          h.mockInput.pressKey("\r")
          await h.renderOnce()
          expect(submitted).toEqual(["first\n"])
          expect(shell.prompt.value).toBe("")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("sent-message recall", () => {
  test("Up recalls the newest sent message, Down returns the draft", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        })
        try {
          setSentMessageHistory(shell, ["first prompt", "second prompt"])
          shell.prompt.value = "draft"
          shell.prompt.cursorOffset = 0

          h.pressKey("ARROW_UP")
          await h.renderOnce()
          expect(shell.prompt.value).toBe("second prompt")

          shell.prompt.cursorOffset = 0
          h.pressKey("ARROW_UP")
          await h.renderOnce()
          expect(shell.prompt.value).toBe("first prompt")

          h.pressKey("ARROW_DOWN")
          await h.renderOnce()
          expect(shell.prompt.value).toBe("second prompt")

          h.pressKey("ARROW_DOWN")
          await h.renderOnce()
          expect(shell.prompt.value).toBe("draft")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("submitting records the message for later recall", async () => {
    await withShell(async (shell) => {
      setShellBridgeHooks(shell, {
        onSubmit: () => {},
        onInterrupt: () => {},
        exclusive: true,
      })
      shell.prompt.value = "remember me"
      submitPrompt(shell)
      expect(shell.sentHistory.sent).toEqual(["remember me"])
    })
  })
})

describe("@-mention suggestions", () => {
  test("opens the mentions overlay for the token under the cursor", async () => {
    await withShell(async (shell) => {
      // The popup lists the directory portion and narrows the listing itself,
      // so the source is asked for `src/`, not the whole typed token.
      setMentionSuggestionSource(shell, async (prefix) => {
        expect(prefix).toBe("src/")
        return ["src/tui/", "src/tui-opentui/", "src/config/"]
      })
      shell.prompt.value = "read @src/tu"
      shell.prompt.cursorOffset = shell.prompt.value.length

      expect(await openAtMentionSuggestions(shell)).toBe(true)
      expect(shell.overlayKind).toBe("mentions")
      expect(shell.overlayItems).toEqual(["src/tui/", "src/tui-opentui/"])
    })
  })

  test("accepting a file splices it into the prompt", async () => {
    await withShell(async (shell) => {
      setMentionSuggestionSource(shell, async () => ["AGENTS.md", "README.md"])
      shell.prompt.value = "read @"
      shell.prompt.cursorOffset = 6

      await openAtMentionSuggestions(shell)
      moveOverlaySelection(shell, 1)
      acceptOverlaySelection(shell)
      expect(shell.prompt.value).toBe("read @README.md")
      expect(shell.overlayKind).toBeNull()
    })
  })

  test("does nothing when the cursor is not inside an @token", async () => {
    await withShell(async (shell) => {
      setMentionSuggestionSource(shell, async () => ["AGENTS.md"])
      shell.prompt.value = "no mention here"
      shell.prompt.cursorOffset = shell.prompt.value.length
      expect(await openAtMentionSuggestions(shell)).toBe(false)
      expect(shell.overlayKind).toBeNull()
    })
  })

  test("typing @ at a word boundary opens the overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "idle",
        })
        try {
          let resolveOpened: () => void = () => {}
          const opened = new Promise<void>((r) => {
            resolveOpened = r
          })
          setMentionSuggestionSource(shell, async () => {
            queueMicrotask(resolveOpened)
            return ["AGENTS.md"]
          })
          h.pressKey("@")
          await opened
          await h.renderOnce()
          expect(shell.prompt.value).toBe("@")
          expect(shell.overlayKind).toBe("mentions")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
