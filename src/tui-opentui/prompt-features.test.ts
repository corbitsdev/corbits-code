/**
 * Integration: prompt-side features wired on the OpenTUI shell —
 * Ctrl+P image attach, sent-message recall, and @-mention suggestions.
 */
import { describe, expect, test } from "bun:test"

import type { PendingImageAttachment } from "../tui/image-attachments.js"
import { withTestRenderer } from "./harness"
import {
  acceptOverlaySelection,
  attachClipboardImage,
  createAppShell,
  moveOverlaySelection,
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
  test("attaches a clipboard image and shows it in the prompt hint", async () => {
    await withShell(async (shell) => {
      setPromptImageSource(shell, async () => ({ ok: true, attachment: CLIP }))
      expect(await attachClipboardImage(shell)).toBe(true)
      expect(shell.pendingAttachments).toHaveLength(1)
      const hint = shell.hint.content.chunks.map((c) => c.text).join("")
      expect(hint).toContain("1 image attached: clipboard.png")
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

  test("Ctrl+P attaches through the wired key handler", async () => {
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
          h.pressKey("p", { ctrl: true })
          await attached
          await h.renderOnce()
          expect(shell.pendingAttachments).toHaveLength(1)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

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
      setMentionSuggestionSource(shell, async (prefix) => {
        expect(prefix).toBe("src/tu")
        return ["src/tui/", "src/tui-opentui/"]
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
