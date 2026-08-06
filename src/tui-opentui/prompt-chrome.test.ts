/**
 * Prompt chrome: bare exit/quit routing and the model_bar label.
 */
import { describe, expect, test } from "bun:test"
import { withTestRenderer } from "./harness"
import {
  createAppShell,
  setPromptModelLabel,
  setShellBridgeHooks,
  setShellExitHandler,
  submitPrompt,
} from "./shell"

async function withShell(
  fn: (shell: ReturnType<typeof createAppShell>) => void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "test",
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      })
      try {
        fn(shell)
      } finally {
        shell.dispose()
      }
    },
    { width: 80, height: 24 },
  )
}

describe("bare exit / quit at the prompt", () => {
  for (const word of ["exit", "quit", "  QUIT  "]) {
    test(`"${word}" runs the host exit handler instead of sending`, async () => {
      await withShell((shell) => {
        const sent: string[] = []
        let exits = 0
        setShellBridgeHooks(shell, {
          onSubmit: (text) => sent.push(text),
          onInterrupt: () => {},
          exclusive: true,
        })
        setShellExitHandler(shell, () => {
          exits += 1
        })
        shell.prompt.value = word
        submitPrompt(shell)
        expect(exits).toBe(1)
        expect(sent).toEqual([])
        expect(shell.prompt.value).toBe("")
      })
    })
  }

  test("a message that merely mentions exit is sent normally", async () => {
    await withShell((shell) => {
      const sent: string[] = []
      let exits = 0
      setShellBridgeHooks(shell, {
        onSubmit: (text) => sent.push(text),
        onInterrupt: () => {},
        exclusive: true,
      })
      setShellExitHandler(shell, () => {
        exits += 1
      })
      shell.prompt.value = "how do I exit"
      submitPrompt(shell)
      expect(exits).toBe(0)
      expect(sent).toEqual(["how do I exit"])
    })
  })

  test("with no exit handler registered, exit is sent as a message", async () => {
    await withShell((shell) => {
      const sent: string[] = []
      setShellBridgeHooks(shell, {
        onSubmit: (text) => sent.push(text),
        onInterrupt: () => {},
        exclusive: true,
      })
      shell.prompt.value = "exit"
      submitPrompt(shell)
      expect(sent).toEqual(["exit"])
    })
  })
})

describe("model bar", () => {
  test("carries the session name before any model label", async () => {
    await withShell((shell) => {
      expect(shell.modelLabel).toBeNull()
      expect(shell.modelBar.visible).toBe(true)
      expect(
        shell.modelBar.content.chunks.map((c) => c.text).join(""),
      ).toEndWith(shell.baseTitle)
    })
  })

  test("joins profile / model / effort and right-aligns", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, {
        profile: "anthropic",
        model: "opus",
        effort: "high",
      })
      expect(shell.modelLabel).toBe("anthropic · opus · high")
      expect(shell.modelBar.visible).toBe(true)
      const painted = shell.modelBar.content.chunks.map((c) => c.text).join("")
      expect(painted).toEndWith(
        `${shell.baseTitle} · anthropic · opus · high`,
      )
      expect(painted.startsWith(" ")).toBe(true)
    })
  })

  test("empty segments fall back to the session name alone", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { model: "opus" })
      setPromptModelLabel(shell, {})
      expect(shell.modelLabel).toBeNull()
      expect(
        shell.modelBar.content.chunks.map((c) => c.text).join("").trim(),
      ).toBe(shell.baseTitle)
    })
  })
})
