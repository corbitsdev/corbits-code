/**
 * Pure unit tests for product-host helpers (no TTY / createCliRenderer).
 */
import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "../permission/types.js"
import {
  operatorResultFromSelection,
  permissionChoices,
  rowFromHistoryBlock,
} from "./product-host.js"

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
    ).toEqual({ role: "tool", text: "ls", meta: "bash" })
    expect(
      rowFromHistoryBlock({
        type: "tool_result",
        name: "bash",
        content: "ok",
        isError: false,
      }),
    ).toEqual({ role: "tool", text: "ok", meta: "bash" })
    expect(
      rowFromHistoryBlock({
        type: "tool_result",
        name: "bash",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "error", meta: "bash!" })
    expect(
      rowFromHistoryBlock({ type: "error", message: "boom" }),
    ).toEqual({ role: "system", text: "boom", meta: "error" })
  })

  test("unknown type → null", () => {
    expect(rowFromHistoryBlock({ type: "unknown" })).toBeNull()
  })
})
