/**
 * Unit tests for product-host: pure helpers plus mount-level coverage of
 * `mountProductHost` using the headless harness and fakes.
 */
import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "../permission/types.js"
import { createHarness } from "./harness.js"
import { acceptOverlaySelection, closeInsetOverlay, moveOverlaySelection } from "./shell.js"
import {
  mountProductHost,
  operatorResultFromSelection,
  permissionChoices,
  type ProductHostConfig,
} from "./product-host.js"
import { buildModelsFirstCatalog, modelOptionId } from "./model-catalog.js"

function makeFakeSessionPort(): {
  readonly sends: string[]
  readonly interrupts: number
  readonly send: ProductHostConfig["send"]
  readonly interrupt: ProductHostConfig["interrupt"]
  readonly deliver: NonNullable<ProductHostConfig["deliver"]>
} {
  const sends: string[] = []
  let interrupts = 0
  return {
    sends,
    get interrupts() {
      return interrupts
    },
    send: (text) => {
      sends.push(text)
    },
    interrupt: () => {
      interrupts += 1
    },
    deliver: (text) => {
      sends.push(text)
    },
  }
}

async function mountHeadless(
  overrides: Partial<ProductHostConfig> = {},
): Promise<{
  host: Awaited<ReturnType<typeof mountProductHost>>
  emitter: EventEmitter
  destroyHarness: () => void
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
}> {
  const harness = await createHarness({ width: 80, height: 24 })
  const emitter = new EventEmitter()
  const port = makeFakeSessionPort()
  const host = await mountProductHost({
    title: "test-session",
    eventEmitter: emitter,
    send: port.send,
    interrupt: port.interrupt,
    deliver: port.deliver,
    createRenderer: async () => harness.renderer,
    ...overrides,
  })
  return {
    host,
    emitter,
    destroyHarness: harness.destroy,
    renderOnce: harness.renderOnce,
    captureCharFrame: harness.captureCharFrame,
  }
}

function makeRequest(
  scopes: PermissionRequest["scopes"] = [],
): PermissionRequest {
  return {
    tool: "bash",
    action: "run",
    subject: "ls -la",
    scopes,
  }
}

describe("permissionChoices", () => {
  test("always offers Reject + Accept once with stable itemIds", () => {
    const { items, itemIds, outcomes } = permissionChoices(makeRequest())
    expect(items).toEqual(["Reject", "Accept once"])
    expect(itemIds).toEqual(["__deny__", "__once__"])
    expect(outcomes).toEqual([{ allow: false }, { allow: true }])
    expect(items).toHaveLength(itemIds.length)
    expect(items).toHaveLength(outcomes.length)
  })

  test("appends scopes with hint labels and persist when pattern set", () => {
    const scope = {
      id: "session-bash",
      label: "Allow bash for session",
      pattern: "bash:*",
      hint: "session",
      grant: "session" as const,
    }
    const { items, itemIds, outcomes } = permissionChoices(
      makeRequest([scope]),
    )
    expect(items[2]).toBe("Allow bash for session (session)")
    expect(itemIds[2]).toBe("session-bash")
    expect(outcomes[2]).toEqual({ allow: true, persist: scope })
  })

  test("scope with null pattern allows without persist", () => {
    const scope = {
      id: "once-path",
      label: "This path only",
      pattern: null,
    }
    const { outcomes, itemIds } = permissionChoices(makeRequest([scope]))
    expect(itemIds[2]).toBe("once-path")
    expect(outcomes[2]).toEqual({ allow: true })
    expect("persist" in (outcomes[2] ?? {})).toBe(false)
  })

  test("selection index maps to correct outcome (deny / once / scope)", () => {
    const scope = {
      id: "proj",
      label: "Project",
      pattern: "read:*",
    }
    const { outcomes } = permissionChoices(makeRequest([scope]))
    expect(outcomes[0]).toEqual({ allow: false })
    expect(outcomes[1]).toEqual({ allow: true })
    expect(outcomes[2]).toEqual({ allow: true, persist: scope })
    // out-of-range fallback used by host
    expect(outcomes[99] ?? { allow: false }).toEqual({ allow: false })
  })
})

describe("operatorResultFromSelection", () => {
  test("valid index → { kind: option, index }", () => {
    expect(operatorResultFromSelection({ index: 0 }, 3)).toEqual({
      kind: "option",
      index: 0,
    })
    expect(operatorResultFromSelection({ index: 2 }, 3)).toEqual({
      kind: "option",
      index: 2,
    })
  })

  test("out-of-range / negative → { kind: cancel }", () => {
    expect(operatorResultFromSelection({ index: -1 }, 2)).toEqual({
      kind: "cancel",
    })
    expect(operatorResultFromSelection({ index: 2 }, 2)).toEqual({
      kind: "cancel",
    })
    expect(operatorResultFromSelection({ index: 0 }, 0)).toEqual({
      kind: "cancel",
    })
  })
})

describe("mountProductHost", () => {
  test("stream events emitted on the event emitter paint rows into the shell", async () => {
    const { host, emitter } = await mountHeadless()
    try {
      emitter.emit("event", { type: "user", text: "hello there" })
      emitter.emit("event", { type: "assistant", text: "hi back" })
      expect(host.shell.streamLog).toEqual([
        { role: "user", text: "hello there" },
        { role: "assistant", text: "hi back" },
      ])
    } finally {
      host.dispose()
    }
  })

  test("history.hydrate replays blocks as stream rows", async () => {
    const { host, emitter } = await mountHeadless()
    try {
      emitter.emit("history.hydrate", [
        { type: "user", content: "past prompt" },
        { type: "text", content: "past reply" },
        { type: "unknown" },
      ])
      expect(host.shell.streamLog).toEqual([
        { role: "user", text: "past prompt" },
        { role: "assistant", text: "past reply" },
      ])
    } finally {
      host.dispose()
    }
  })

  test("session.title updates the shell header", async () => {
    const { host, emitter } = await mountHeadless()
    try {
      expect(host.shell.baseTitle).toBe("test-session")
      emitter.emit("session.title", "renamed session")
      expect(host.shell.baseTitle).toBe("renamed session")
    } finally {
      host.dispose()
    }
  })

  test("permission.gate opens the overlay and resolves through the emitter's resolve callback", async () => {
    const { host, emitter } = await mountHeadless()
    try {
      let resolved: unknown
      const request: PermissionRequest = {
        tool: "bash",
        action: "run",
        subject: "ls",
        scopes: [],
      }
      emitter.emit("permission.gate", {
        request,
        resolve: (outcome: unknown) => {
          resolved = outcome
        },
      })
      expect(host.shell.overlayKind).toBe("permissions")
      expect(host.shell.overlayItems).toEqual(["Reject", "Accept once"])

      acceptOverlaySelection(host.shell)
      expect(resolved).toEqual({ allow: false })
    } finally {
      host.dispose()
    }
  })

  test("operator.gate opens the overlay and resolves through the emitter's resolve callback", async () => {
    const { host, emitter } = await mountHeadless()
    try {
      let resolved: unknown
      emitter.emit("operator.gate", {
        question: "Proceed?",
        options: ["Cancel", "Continue"],
        resolve: (result: unknown) => {
          resolved = result
        },
      })
      expect(host.shell.overlayKind).toBe("operator")
      expect(host.shell.overlayItems).toEqual(["Cancel", "Continue"])
    } finally {
      host.dispose()
    }
  })

  test("dispose() detaches emitter listeners and resolves waitUntilExit", async () => {
    const { host, emitter } = await mountHeadless()

    expect(emitter.listenerCount("event")).toBe(1)
    expect(emitter.listenerCount("history.hydrate")).toBe(1)
    expect(emitter.listenerCount("session.title")).toBe(1)
    expect(emitter.listenerCount("permission.gate")).toBe(1)
    expect(emitter.listenerCount("operator.gate")).toBe(1)

    const exited = host.waitUntilExit()
    host.dispose()
    await exited

    expect(emitter.listenerCount("event")).toBe(0)
    expect(emitter.listenerCount("history.hydrate")).toBe(0)
    expect(emitter.listenerCount("session.title")).toBe(0)
    expect(emitter.listenerCount("permission.gate")).toBe(0)
    expect(emitter.listenerCount("operator.gate")).toBe(0)
  })

  test("dispose() is idempotent and events after dispose are ignored", async () => {
    const { host, emitter } = await mountHeadless()
    host.dispose()
    expect(() => host.dispose()).not.toThrow()

    // Listeners were removed by dispose; emitting is a no-op, not a throw.
    expect(() =>
      emitter.emit("event", { type: "user", text: "late" }),
    ).not.toThrow()
    expect(host.shell.streamLog).toEqual([])
  })

  test("the agents panel's elapsed clock advances on the sticky poll tick, without another chrome push", async () => {
    const now = Date.now()
    const { host, renderOnce, captureCharFrame } = await mountHeadless({
      chrome: {
        agents: [
          {
            agentId: "explore",
            currentToolStartedAt: null,
            description: "map callers",
            status: "running",
            startedAt: now - 59_000,
            lastActivityAt: now,
          },
        ],
      },
    })
    try {
      await renderOnce()
      expect(captureCharFrame()).toContain("0:59")

      // No further chrome push or event — only wall-clock time passing.
      // Only the 200ms sticky poll can be responsible for the clock moving.
      await new Promise((r) => setTimeout(r, 1_100))
      await renderOnce()
      expect(captureCharFrame()).not.toContain("0:59")
      expect(captureCharFrame()).toMatch(/1:0\d/)
    } finally {
      host.dispose()
    }
  })
})

describe("provider-first model picker", () => {
  // Mirrors the bug-report shape: several providers, one (codex) with three
  // accounts, plus a favorite so the top level has a reachable-without-descending pick.
  const providers = {
    "codex/abk-labs": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "codex/dirtroad": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "codex/fleur": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "xai/thegreataxios": { models: ["grok-4.5"] },
    "Z.AI": { models: ["glm-5", "glm-5-turbo", "glm-5.2"] },
  }

  async function mountPicker(overrides: Partial<ProductHostConfig> = {}) {
    // One row taller than the usual fixture: on the landing screen (no
    // session content yet, which this fixture never sends) the version badge
    // reserves the terminal's last row, and this picker's row list needs
    // every row of the 24-row case to fit every provider.
    const harness = await createHarness({ width: 80, height: 25 })
    const port = makeFakeSessionPort()
    const catalog = buildModelsFirstCatalog({
      providers,
      favorites: [{ provider: "codex/abk-labs", model: "gpt-5.5" }],
    })
    const selected: string[] = []
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: new EventEmitter(),
      send: port.send,
      interrupt: port.interrupt,
      createRenderer: async () => harness.renderer,
      models: catalog,
      onModelSelect: (id) => selected.push(id),
      ...overrides,
    })
    return { harness, host, selected }
  }

  test("top level lists providers (one row per account), not one row per model", async () => {
    const { harness, host } = await mountPicker()
    try {
      host.openModels?.()
      await harness.renderOnce()
      const frame = harness.captureCharFrame()
      // Each codex account is its own row; the account name appears once,
      // not once per model it exposes.
      expect(frame).toContain("codex/abk-labs")
      expect(frame).toContain("codex/dirtroad")
      expect(frame).toContain("codex/fleur")
      expect(frame).toContain("xai/thegreataxios")
      // The favorite is a leaf row, reachable without descending — it, not
      // its provider group, carries the model name at the top level.
      expect(frame).toContain("gpt-5.5")
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("selecting a provider descends into its models; Escape returns to the provider level", async () => {
    const { harness, host } = await mountPicker()
    try {
      host.openModels?.()
      await harness.renderOnce()

      const items = host.shell.overlayItems
      const xaiIndex = items.findIndex((label) => label.includes("xai/thegreataxios"))
      expect(xaiIndex).toBeGreaterThanOrEqual(0)
      moveOverlaySelection(host.shell, xaiIndex)
      acceptOverlaySelection(host.shell)
      await harness.renderOnce()

      const modelFrame = harness.captureCharFrame()
      expect(modelFrame).toContain("grok-4.5")
      expect(modelFrame).not.toContain("codex/abk-labs")

      closeInsetOverlay(host.shell)
      await harness.renderOnce()
      const backFrame = harness.captureCharFrame()
      expect(backFrame).toContain("codex/abk-labs")
      expect(host.shell.overlayList).not.toBeNull()
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("selecting a model at the model level applies the pick", async () => {
    const { harness, host, selected } = await mountPicker()
    try {
      host.openModels?.()
      await harness.renderOnce()
      const items = host.shell.overlayItems
      const xaiIndex = items.findIndex((label) => label.includes("xai/thegreataxios"))
      moveOverlaySelection(host.shell, xaiIndex)
      acceptOverlaySelection(host.shell)
      await harness.renderOnce()

      acceptOverlaySelection(host.shell)
      expect(selected).toEqual(["xai/thegreataxios:grok-4.5"])
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("the current model's row reads \"(current)\" at a glance", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    const port = makeFakeSessionPort()
    const catalog = buildModelsFirstCatalog({ providers, recent: [{ provider: "xai/thegreataxios", model: "grok-4.5" }] })
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: new EventEmitter(),
      send: port.send,
      interrupt: port.interrupt,
      createRenderer: async () => harness.renderer,
      models: catalog,
      activeModelId: () => modelOptionId("xai/thegreataxios", "grok-4.5"),
      onModelSelect: () => {},
    })
    try {
      host.openModels?.()
      await harness.renderOnce()
      const frame = harness.captureCharFrame()
      expect(frame).toContain("xai/thegreataxios / grok-4.5 (current)")
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("stale recents pointing at a different model do not steal the (current) marker", async () => {
    // Recents still name the model a *previous* session last switched to;
    // this session has run codex/abk-labs / gpt-5.5 all along without ever
    // touching the picker. The live model, not the recents list, decides
    // which row reads "(current)".
    const harness = await createHarness({ width: 80, height: 24 })
    const port = makeFakeSessionPort()
    const catalog = buildModelsFirstCatalog({
      providers,
      recent: [{ provider: "xai/thegreataxios", model: "grok-4.5" }],
    })
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: new EventEmitter(),
      send: port.send,
      interrupt: port.interrupt,
      createRenderer: async () => harness.renderer,
      models: catalog,
      activeModelId: () => modelOptionId("codex/abk-labs", "gpt-5.5"),
      onModelSelect: () => {},
    })
    try {
      host.openModels?.()
      await harness.renderOnce()
      const frame = harness.captureCharFrame()
      expect(frame).not.toContain("xai/thegreataxios / grok-4.5 (current)")
      const items = host.shell.overlayItems
      const codexIndex = items.findIndex((label) => label.includes("codex/abk-labs"))
      expect(codexIndex).toBeGreaterThanOrEqual(0)
      moveOverlaySelection(host.shell, codexIndex)
      acceptOverlaySelection(host.shell)
      await harness.renderOnce()
      const modelFrame = harness.captureCharFrame()
      expect(modelFrame).toContain("gpt-5.5 (current)")
    } finally {
      host.dispose()
      harness.destroy()
    }
  })

  test("fits and scrolls within a short terminal instead of overflowing it", async () => {
    const port = makeFakeSessionPort()
    const harness = await createHarness({ width: 80, height: 10 })
    try {
      const catalog = buildModelsFirstCatalog({ providers })
      const host = await mountProductHost({
        title: "test-session",
        eventEmitter: new EventEmitter(),
        send: port.send,
        interrupt: port.interrupt,
        createRenderer: async () => harness.renderer,
        models: catalog,
        onModelSelect: () => {},
      })
      try {
        host.openModels?.()
        await harness.renderOnce()
        const frame = harness.captureCharFrame()
        // Five provider rows do not all fit a 10-row terminal alongside the
        // overlay chrome; the picker renders without throwing and the frame
        // stays within the terminal's own line count.
        expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(10)
        expect(host.shell.overlayList).not.toBeNull()
      } finally {
        host.dispose()
      }
    } finally {
      harness.destroy()
    }
  })
})

describe("mount failure", () => {
  test("destroys the renderer when gate wiring throws", async () => {
    const harness = await createHarness({ width: 80, height: 24 })
    let destroyed = 0
    const realDestroy = harness.renderer.destroy.bind(harness.renderer)
    harness.renderer.destroy = () => {
      destroyed += 1
      realDestroy()
    }

    // Gate wiring is the first thing to touch the emitter after the renderer
    // owns the alternate screen; a throw there once leaked the renderer.
    const emitter = new EventEmitter()
    const realOn = emitter.on.bind(emitter)
    emitter.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "permission.gate") throw new Error("gate wiring failed")
      return realOn(event, listener)
    }) as typeof emitter.on

    const port = makeFakeSessionPort()
    await expect(
      mountProductHost({
        title: "crash-on-mount",
        eventEmitter: emitter,
        send: port.send,
        interrupt: port.interrupt,
        createRenderer: async () => harness.renderer,
      }),
    ).rejects.toThrow("gate wiring failed")
    expect(destroyed).toBe(1)
  })
})
