/**
 * Focus routing: typing always reaches the surface that is obviously active,
 * with no click. Driven through the harness — keys in, rendered frame out.
 */
import { describe, expect, test } from "bun:test"
import { focusOwner } from "./focus/index"
import { createHarness, withTestRenderer, type Harness } from "./harness"
import { openPermissionsOverlay } from "./overlays"
import { providerChoiceRows, runProviderSetup } from "./provider-setup"
import {
  appendStreamRow,
  closeInsetOverlay,
  createAppShell,
  enterSubagentObserve,
  leaveSubagentObserve,
  openInsetOverlay,
  openPalette,
  toggleShellFocus,
  type AppShell,
} from "./shell"

async function typeInto(h: Harness, text: string): Promise<void> {
  for (const ch of text) h.mockInput.pressKey(ch)
  await h.renderOnce()
}

/** Every focusable in the tree that OpenTUI currently reports as focused. */
function focusedIds(shell: AppShell): readonly string[] {
  const found: string[] = []
  const walk = (node: { id: string; focused?: boolean; getChildren: () => readonly unknown[] }): void => {
    if (node.focused === true) found.push(node.id)
    for (const kid of node.getChildren()) {
      walk(kid as Parameters<typeof walk>[0])
    }
  }
  walk(shell.renderer.root as unknown as Parameters<typeof walk>[0])
  return found
}

describe("focus routing", () => {
  test("landing accepts typing immediately after mount", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          expect(focusOwner(shell.focus)).toBe("prompt")
          await typeInto(h, "hi")
          expect(shell.prompt.value).toBe("hi")
          expect(h.captureCharFrame()).toContain("hi")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("exactly one focus owner across overlay open and close", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          expect(focusedIds(shell)).toEqual(["shell-prompt"])
          openInsetOverlay(shell, ["allow", "deny"])
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("overlay")
          expect(focusedIds(shell)).toEqual([])
          closeInsetOverlay(shell)
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(focusedIds(shell)).toEqual(["shell-prompt"])
          await typeInto(h, "ok")
          expect(shell.prompt.value).toBe("ok")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("palette closes back to a typable prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          openPalette(shell, { typeToFilter: true })
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("palette")
          closeInsetOverlay(shell)
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("prompt")
          await typeInto(h, "z")
          expect(shell.prompt.value).toBe("z")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("observe keeps typing out of the parent prompt and gives it back on exit", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          enterSubagentObserve(shell, {
            sessionId: "s1",
            agentId: "child",
            description: "worker",
            lines: [{ role: "system", text: "child row" }],
          })
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("observe")
          expect(focusedIds(shell)).toEqual([])
          await typeInto(h, "xyz")
          expect(shell.prompt.value).toBe("")
          leaveSubagentObserve(shell)
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(focusedIds(shell)).toEqual(["shell-prompt"])
          await typeInto(h, "back")
          expect(shell.prompt.value).toBe("back")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("transcript browse never leaves the prompt focused as well", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          toggleShellFocus(shell)
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("transcript")
          expect(focusedIds(shell)).toEqual(["shell-transcript"])
          toggleShellFocus(shell)
          await h.renderOnce()
          expect(focusedIds(shell)).toEqual(["shell-prompt"])
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("transcript output arriving mid-compose leaves the prompt focused", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          await typeInto(h, "half")
          appendStreamRow(shell, { role: "assistant", text: "streamed" })
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("prompt")
          await typeInto(h, "-done")
          expect(shell.prompt.value).toBe("half-done")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a permission gate is the modal exception and hands the draft back", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "focus" })
        try {
          await typeInto(h, "draft")
          openPermissionsOverlay(shell, {
            items: ["allow", "deny"],
            itemIds: ["allow", "deny"],
            body: "run ls",
          })
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("overlay")
          expect(focusedIds(shell)).toEqual([])
          // The draft survives the interruption untouched.
          await typeInto(h, "!!")
          expect(shell.prompt.value).toBe("draft")
          closeInsetOverlay(shell)
          await h.renderOnce()
          expect(focusedIds(shell)).toEqual(["shell-prompt"])
          await typeInto(h, "!")
          expect(shell.prompt.value).toBe("draft!")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("onboarding focus", () => {
  test("the first field takes typing with no click", async () => {
    const h = await createHarness({ width: 80, height: 30 })
    const seen: string[] = []
    const done = runProviderSetup({
      onSubmit: async (values) => {
        seen.push(values.name)
      },
      showTelemetryNotice: false,
      createRenderer: async () => h.renderer,
    })
    try {
      await h.renderOnce()
      const ids = providerChoiceRows().map((r) => r.id)
      for (let i = 0; i < ids.indexOf("custom"); i++) h.pressKey("ARROW_DOWN")
      h.pressKey("Enter")
      await h.renderOnce()
      // No focus call in between: the name field is live the moment it appears.
      for (const ch of "firepass") h.pressKey(ch)
      await h.renderOnce()
      expect(h.captureCharFrame()).toContain("firepass")
      h.pressKey("Ctrl+C")
      await done
    } finally {
      h.destroy()
    }
    expect(seen).toEqual([])
  })
})

describe("esc from transcript browse", () => {
  test("Esc while transcript-focused returns focus to the prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, { title: "esc" })
        try {
          toggleShellFocus(shell)
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("transcript")

          // ESC needs a disambiguation delay on the mock stdin path.
          h.pressKey("Escape")
          await new Promise((r) => setTimeout(r, 60))
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(focusedIds(shell)).toEqual([shell.prompt.id])

          for (const ch of "back") h.pressKey(ch)
          await h.renderOnce()
          expect(shell.prompt.value).toBe("back")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
