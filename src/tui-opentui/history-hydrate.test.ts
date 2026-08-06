import { describe, expect, test } from "bun:test"
import {
  hydrateHistoryRows,
  rowFromHistoryBlock,
  rowsFromHistoryBlocks,
} from "./history-hydrate.js"

describe("rowFromHistoryBlock", () => {
  test("user / text / reply / thinking", () => {
    expect(rowFromHistoryBlock({ type: "user", content: "hi" })).toEqual({
      role: "user",
      text: "hi",
    })
    expect(rowFromHistoryBlock({ type: "text", content: "ok" })).toEqual({
      role: "assistant",
      text: "ok",
    })
    expect(rowFromHistoryBlock({ type: "reply", content: "done" })).toEqual({
      role: "assistant",
      text: "done",
    })
    expect(
      rowFromHistoryBlock({ type: "thinking", content: "hmm" }),
    ).toEqual({
      role: "system",
      text: "hmm",
      meta: "thinking",
    })
  })

  test("tool_call uses content or arguments", () => {
    expect(
      rowFromHistoryBlock({
        type: "tool_call",
        name: "grep",
        content: "pattern x",
      }),
    ).toEqual({ role: "tool", text: "pattern x", meta: "grep" })
    expect(
      rowFromHistoryBlock({
        type: "tool_call",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      }),
    ).toEqual({
      role: "tool",
      text: '{"path":"a.ts"}',
      meta: "read_file",
    })
    expect(rowFromHistoryBlock({ type: "tool_call" })).toEqual({
      role: "tool",
      text: "…",
      meta: "tool",
    })
  })

  test("tool_result success and error", () => {
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
  })

  test("error and unknown", () => {
    expect(
      rowFromHistoryBlock({ type: "error", message: "boom" }),
    ).toEqual({ role: "system", text: "boom", meta: "error" })
    expect(rowFromHistoryBlock({ type: "tasks" })).toBeNull()
    expect(rowFromHistoryBlock({ type: "plan" })).toBeNull()
    expect(rowFromHistoryBlock({ type: "view" })).toBeNull()
  })
})

describe("hydrateHistoryRows", () => {
  test("maps block array and skips junk", () => {
    const rows = hydrateHistoryRows([
      { type: "user", content: "parent user", id: "u1" },
      null,
      "skip",
      { type: "text", content: "assistant line" },
      { type: "tasks", tasks: [] },
      {
        type: "tool_call",
        name: "read_file",
        arguments: '{"path":"x"}',
      },
      {
        type: "tool_result",
        name: "read_file",
        content: "body",
        isError: false,
      },
      { type: "error", message: "fail" },
    ])
    expect(rows).toEqual([
      { role: "user", text: "parent user" },
      { role: "assistant", text: "assistant line" },
      { role: "tool", text: '{"path":"x"}', meta: "read_file" },
      { role: "tool", text: "body", meta: "read_file", result: true },
      { role: "system", text: "fail", meta: "error" },
    ])
  })

  test("non-array returns empty", () => {
    expect(hydrateHistoryRows(undefined)).toEqual([])
    expect(hydrateHistoryRows(null)).toEqual([])
    expect(hydrateHistoryRows({ type: "user" })).toEqual([])
  })

  test("rowsFromHistoryBlocks is typed convenience", () => {
    expect(
      rowsFromHistoryBlocks([
        { type: "user", content: "a" },
        { type: "reply", content: "b" },
      ]),
    ).toEqual([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
    ])
  })
})
