import { describe, expect, test } from "bun:test"
import {
  EMPTY_PLAN_DETAIL,
  EMPTY_TASKS_DETAIL,
  EMPTY_VIEW_DETAIL,
  hydrateHistoryRows,
  MISSING_ERROR_DETAIL,
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
    ).toEqual({
      role: "tool",
      text: "pattern x",
      meta: "grep",
      verb: "Grep",
      summary: "pattern x",
      pending: true,
      callKey: "grep Grep pattern x",
    })
    expect(
      rowFromHistoryBlock({
        type: "tool_call",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      }),
    ).toMatchObject({
      role: "tool",
      text: '{"path":"a.ts"}',
      meta: "read_file",
      summary: "a.ts",
    })
    expect(rowFromHistoryBlock({ type: "tool_call" })).toEqual({
      role: "tool",
      text: "…",
      meta: "tool",
      pending: true,
      callKey: "tool  ",
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
    ).toEqual({ role: "tool", text: "ok", meta: "bash" })
    expect(
      rowFromHistoryBlock({
        type: "tool_result",
        name: "bash",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "error", meta: "bash", failed: true })
  })

  test("error and unknown", () => {
    expect(
      rowFromHistoryBlock({ type: "error", message: "boom" }),
    ).toEqual({ role: "system", text: "boom", meta: "error" })
    // A resumed error with no recorded message says so, rather than sitting
    // in the transcript as the bare word "error".
    expect(rowFromHistoryBlock({ type: "error" })).toEqual({
      role: "system",
      text: MISSING_ERROR_DETAIL,
      meta: "error",
    })
    expect(MISSING_ERROR_DETAIL).toBe(
      "this step failed and the details were not saved",
    )
    expect(rowFromHistoryBlock({ type: "who-knows" })).toBeNull()
  })

  test("view hydrates as an assistant row carrying the view text", () => {
    const row = rowFromHistoryBlock({
      type: "view",
      node: {
        type: "stack",
        children: [
          { type: "text", text: "Deploy summary" },
          { type: "text", text: "3 services updated" },
        ],
      },
    })
    expect(row?.role).toBe("assistant")
    expect(row?.markdown).toBe(false)
    expect(row?.text).toContain("Deploy summary")
    expect(row?.text).toContain("3 services updated")
  })

  test("view with no paintable tree still says something", () => {
    expect(rowFromHistoryBlock({ type: "view" })).toEqual({
      role: "assistant",
      text: EMPTY_VIEW_DETAIL,
      markdown: false,
    })
    expect(rowFromHistoryBlock({ type: "view", node: { type: "bogus" } })).toEqual({
      role: "assistant",
      text: EMPTY_VIEW_DETAIL,
      markdown: false,
    })
  })

  test("plan hydrates as a system row listing its steps", () => {
    expect(
      rowFromHistoryBlock({
        type: "plan",
        steps: [
          { file: "src/a.ts", action: "edit", reason: "wire the gate" },
          { file: "src/b.ts", action: "create" },
        ],
      }),
    ).toEqual({
      role: "system",
      text: "- edit src/a.ts — wire the gate\n- create src/b.ts",
      meta: "plan",
    })
    expect(rowFromHistoryBlock({ type: "plan", steps: [] })).toEqual({
      role: "system",
      text: EMPTY_PLAN_DETAIL,
      meta: "plan",
    })
  })

  test("tasks hydrates as a system row listing task titles", () => {
    expect(
      rowFromHistoryBlock({
        type: "tasks",
        tasks: [
          { id: "1", title: "Fix hydrate", status: "done" },
          { id: "2", title: "Ship it", status: "todo" },
        ],
      }),
    ).toEqual({
      role: "system",
      text: "- Fix hydrate (done)\n- Ship it (todo)",
      meta: "tasks",
    })
    expect(rowFromHistoryBlock({ type: "tasks" })).toEqual({
      role: "system",
      text: EMPTY_TASKS_DETAIL,
      meta: "tasks",
    })
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
    // The call and its result hydrate as the one row a live turn would paint.
    expect(rows).toMatchObject([
      { role: "user", text: "parent user" },
      { role: "assistant", text: "assistant line" },
      { role: "system", text: EMPTY_TASKS_DETAIL, meta: "tasks" },
      { role: "tool", text: "body", meta: "read_file", summary: "x", verb: "Read" },
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
