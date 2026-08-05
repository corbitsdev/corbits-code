import { describe, expect, test } from "bun:test"
import {
  classifyCopy,
  copyStreamRow,
  createRecordingClipboard,
  formatCopyText,
  pickCopyRow,
} from "./copy-path"
import type { StreamRow } from "./stream"

describe("classifyCopy", () => {
  test("tool role", () => {
    expect(classifyCopy({ role: "tool", text: "ls", meta: "bash" })).toBe(
      "tool",
    )
  })

  test("diff body", () => {
    const row: StreamRow = {
      role: "assistant",
      text: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    }
    expect(classifyCopy(row)).toBe("diff")
  })

  test("plain message", () => {
    expect(classifyCopy({ role: "user", text: "hello" })).toBe("message")
  })
})

describe("formatCopyText / copyStreamRow", () => {
  test("writes plain text and summary", () => {
    const port = createRecordingClipboard()
    const payload = copyStreamRow(
      { role: "assistant", text: "hello world" },
      port,
    )
    expect(payload).not.toBeNull()
    expect(payload!.kind).toBe("message")
    expect(payload!.text).toBe("hello world")
    expect(port.writes).toEqual(["hello world"])
    expect(payload!.summary).toContain("copied message")
  })

  test("tool includes meta", () => {
    const port = createRecordingClipboard()
    const payload = copyStreamRow(
      { role: "tool", text: "ok", meta: "bash" },
      port,
    )
    expect(payload!.text).toBe("[bash] ok")
    expect(payload!.kind).toBe("tool")
  })

  test("null when no row", () => {
    const port = createRecordingClipboard()
    expect(copyStreamRow(null, port)).toBeNull()
    expect(port.writes).toEqual([])
  })
})

describe("pickCopyRow", () => {
  const log: StreamRow[] = [
    { role: "user", text: "u" },
    { role: "system", text: "s" },
    { role: "assistant", text: "a" },
    { role: "system", text: "done" },
  ]

  test("prefers last non-system", () => {
    expect(pickCopyRow(log)?.text).toBe("a")
  })

  test("explicit index", () => {
    expect(pickCopyRow(log, 0)?.text).toBe("u")
  })

  test("empty", () => {
    expect(pickCopyRow([])).toBeNull()
  })
})

describe("formatCopyText length preview", () => {
  test("truncates long summary", () => {
    const long = "x".repeat(80)
    const p = formatCopyText({ role: "user", text: long })
    expect(p.text).toBe(long)
    expect(p.summary.length).toBeLessThan(long.length + 40)
    expect(p.summary).toContain("…")
  })
})
