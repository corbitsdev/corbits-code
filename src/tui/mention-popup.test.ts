/**
 * Integration: the `@` path popup narrows as you type, the same contract the
 * `/` command popup already honours.
 */
import { describe, expect, test } from "bun:test"

import type { KeyEvent } from "@opentui/core"

import { withTestRenderer } from "./harness"
import {
  acceptOverlaySelection,
  createAppShell,
  handleMentionPopupKey,
  isMentionPopupOpen,
  openAtMentionSuggestions,
  setMentionSuggestionSource,
  type AppShell,
} from "./shell"

const TREE: Readonly<Record<string, readonly string[]>> = {
  "": ["AGENTS.md", "README.md", "session-notes.md", "src/"],
  "src/": ["src/session.ts", "src/shell.ts", "src/parse-session.ts"],
}

function withShell(fn: (shell: AppShell) => Promise<void>): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      setMentionSuggestionSource(shell, async (prefix) => {
        const listing = TREE[prefix]
        if (listing !== undefined) return [...listing]
        // Fallback query path: the source's own prefix filter.
        const dir = prefix.slice(0, prefix.lastIndexOf("/") + 1)
        return (TREE[dir] ?? []).filter((e) => e.startsWith(prefix))
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

function printable(seq: string): KeyEvent {
  return {
    name: seq,
    sequence: seq,
    ctrl: false,
    meta: false,
    option: false,
  } as unknown as KeyEvent
}

const BACKSPACE = {
  name: "backspace",
  sequence: "",
  ctrl: false,
  meta: false,
  option: false,
} as unknown as KeyEvent

/** Drive one key and let the popup's async re-query settle. */
async function type(shell: AppShell, key: KeyEvent): Promise<boolean> {
  const handled = handleMentionPopupKey(shell, key)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  return handled
}

async function openAt(shell: AppShell, value: string): Promise<void> {
  shell.prompt.value = value
  shell.prompt.cursorOffset = value.length
  await openAtMentionSuggestions(shell)
}

describe("@ popup narrows as you type", () => {
  test("printable keys filter the list and land in the prompt", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "read @")
      expect(shell.overlayItems.length).toBe(4)

      expect(await type(shell, printable("s"))).toBe(true)
      expect(shell.prompt.value).toBe("read @s")
      expect(shell.overlayItems).toEqual([
        "session-notes.md",
        "src/",
        "AGENTS.md",
      ])

      await type(shell, printable("e"))
      expect(shell.prompt.value).toBe("read @se")
      expect(shell.overlayItems).toEqual(["session-notes.md"])
    })
  })

  test("backspace widens the list again", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "read @se")
      expect(shell.overlayItems).toEqual(["session-notes.md"])

      expect(await type(shell, BACKSPACE)).toBe(true)
      expect(shell.prompt.value).toBe("read @s")
      expect(shell.overlayItems).toEqual([
        "session-notes.md",
        "src/",
        "AGENTS.md",
      ])
    })
  })

  test("substring match finds an entry the fragment does not start", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@")
      await type(shell, printable("n"))
      expect(shell.overlayItems).toEqual(["AGENTS.md", "session-notes.md"])
    })
  })

  test("quitting mid-lookup does not write into the disposed shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        let resolveLookup: (entries: readonly string[]) => void = () => {}
        setMentionSuggestionSource(
          shell,
          () =>
            new Promise<readonly string[]>((resolve) => {
              resolveLookup = resolve
            }),
        )

        shell.prompt.value = "read @"
        shell.prompt.cursorOffset = shell.prompt.value.length
        const pending = openAtMentionSuggestions(shell)

        // The operator quits before the filesystem lookup answers.
        shell.dispose()
        resolveLookup(["AGENTS.md", "README.md"])

        await expect(pending).resolves.toBe(false)
        expect(shell.overlayKind).toBeNull()
        expect(isMentionPopupOpen(shell)).toBe(false)
      },
      { width: 80, height: 24 },
    )
  })

  test("no match closes the popup and leaves the typed text", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@")
      await type(shell, printable("z"))
      expect(shell.prompt.value).toBe("@z")
      expect(shell.overlayKind).toBeNull()
      expect(isMentionPopupOpen(shell)).toBe(false)
      // Mirrors `/`: no empty-state message, not even a status flash.
      expect(shell.statusFlash).toBeNull()
    })
  })

  test("deleting the @ ends the popup", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@")
      await type(shell, BACKSPACE)
      expect(shell.prompt.value).toBe("")
      expect(shell.overlayKind).toBeNull()
    })
  })

  test("whitespace terminates the token", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@")
      await type(shell, printable(" "))
      expect(shell.prompt.value).toBe("@ ")
      expect(shell.overlayKind).toBeNull()
    })
  })

  test("navigation keys stay with the overlay", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@")
      const down = { name: "down", ctrl: false, meta: false, option: false }
      expect(handleMentionPopupKey(shell, down as unknown as KeyEvent)).toBe(false)
    })
  })

  test("directory drill-in still lists one level down", async () => {
    await withShell(async (shell) => {
      await openAt(shell, "@")
      await type(shell, printable("s"))
      await type(shell, printable("r"))
      expect(shell.overlayItems).toEqual(["src/"])

      acceptOverlaySelection(shell)
      // The accept splices `src/` and re-opens; let the re-query settle.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(shell.prompt.value).toBe("@src/")
      expect(shell.overlayKind).toBe("mentions")
      expect(shell.overlayItems).toEqual([
        "src/session.ts",
        "src/shell.ts",
        "src/parse-session.ts",
      ])

      // Filtering keeps working after the drill-in.
      await type(shell, printable("s"))
      expect(shell.prompt.value).toBe("@src/s")
      expect(shell.overlayItems).toEqual([
        "src/session.ts",
        "src/shell.ts",
        "src/parse-session.ts",
      ])
    })
  })
})
