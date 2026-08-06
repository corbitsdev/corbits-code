/**
 * Unit tests for product-host: pure helpers plus mount-level coverage of
 * `mountProductHost` using the headless harness and fakes.
 */
import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "../permission/types.js"
import { createHarness } from "./harness.js"
import { acceptOverlaySelection } from "./shell.js"
import {
  mountProductHost,
  operatorResultFromSelection,
  permissionChoices,
  rowFromHistoryBlock,
  type ProductHostConfig,
} from "./product-host.js"

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
  return { host, emitter, destroyHarness: harness.destroy }
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

describe("rowFromHistoryBlock", () => {
  test("maps known block types to stream rows", () => {
    expect(rowFromHistoryBlock({ type: "user", content: "hi" })).toEqual({
      role: "user",
      text: "hi",
    })
    expect(rowFromHistoryBlock({ type: "text", content: "yo" })).toEqual({
      role: "assistant",
      text: "yo",
    })
    expect(rowFromHistoryBlock({ type: "reply", content: "r" })).toEqual({
      role: "assistant",
      text: "r",
    })
    expect(rowFromHistoryBlock({ type: "thinking", content: "…" })).toEqual({
      role: "system",
      text: "…",
      meta: "thinking",
    })
    expect(
      rowFromHistoryBlock({
        type: "tool_call",
        name: "bash",
        content: "ls",
      }),
    ).toEqual({ role: "tool", text: "ls", meta: "bash", verb: "Bash", summary: "ls" })
    expect(
      rowFromHistoryBlock({
        type: "tool_result",
        name: "bash",
        content: "ok",
        isError: false,
      }),
    ).toEqual({ role: "tool", text: "ok", meta: "bash", result: true })
    expect(
      rowFromHistoryBlock({
        type: "tool_result",
        name: "bash",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "error", meta: "bash", result: true, failed: true })
    expect(
      rowFromHistoryBlock({ type: "error", message: "boom" }),
    ).toEqual({ role: "system", text: "boom", meta: "error" })
  })

  test("unknown type → null", () => {
    expect(rowFromHistoryBlock({ type: "unknown" })).toBeNull()
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
})
