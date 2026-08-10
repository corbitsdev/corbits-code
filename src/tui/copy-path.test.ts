import { describe, expect, test } from "bun:test"
import {
  buildCopyTargets,
  classifyCopy,
  copyStreamRow,
  createRecordingClipboard,
  formatCopyText,
  pickCopyRow,
  streamLogMarkdown,
  writeClipboard,
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

describe("writeClipboard", () => {
  test("sync success runs onSuccess", () => {
    const events: string[] = []
    writeClipboard(
      {
        writeText: (text) => {
          events.push(`write:${text}`)
        },
      },
      "hi",
      {
        onSuccess: () => events.push("ok"),
        onFailure: () => events.push("fail"),
      },
    )
    expect(events).toEqual(["write:hi", "ok"])
  })

  test("sync throw runs onFailure", () => {
    const events: string[] = []
    writeClipboard(
      {
        writeText: () => {
          throw new Error("nope")
        },
      },
      "hi",
      {
        onSuccess: () => events.push("ok"),
        onFailure: () => events.push("fail"),
      },
    )
    expect(events).toEqual(["fail"])
  })

  test("async resolve defers onSuccess", async () => {
    let resolveWrite!: () => void
    const writeP = new Promise<void>((r) => {
      resolveWrite = r
    })
    const events: string[] = []
    writeClipboard(
      { writeText: () => writeP },
      "hi",
      {
        onSuccess: () => events.push("ok"),
        onFailure: () => events.push("fail"),
      },
    )
    expect(events).toEqual([])
    resolveWrite()
    await writeP
    await Promise.resolve()
    expect(events).toEqual(["ok"])
  })

  test("async reject runs onFailure", async () => {
    const events: string[] = []
    writeClipboard(
      { writeText: () => Promise.reject(new Error("nope")) },
      "hi",
      {
        onSuccess: () => events.push("ok"),
        onFailure: () => events.push("fail"),
      },
    )
    expect(events).toEqual([])
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(["fail"])
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

describe("buildCopyTargets", () => {
  test("skips system and freezes oldest-first with last as default pick", () => {
    const log: StreamRow[] = [
      { role: "user", text: "first" },
      { role: "system", text: "noise" },
      { role: "assistant", text: "second" },
      { role: "tool", text: "out", meta: "bash" },
    ]
    const targets = buildCopyTargets(log)
    expect(targets.map((t) => t.text)).toEqual([
      "first",
      "second",
      "[bash] out",
    ])
    expect(targets[0]?.label).toBe("your message")
    expect(targets[2]?.label).toBe("bash output")
    // Ink default: last target
    expect(targets[targets.length - 1]?.text).toBe("[bash] out")
  })

  test("empty log", () => {
    expect(buildCopyTargets([])).toEqual([])
  })

  test("streamLogMarkdown joins frozen targets", () => {
    const md = streamLogMarkdown([
      { id: "1", label: "your message", preview: "hi", text: "hi" },
      { id: "2", label: "assistant message", preview: "yo", text: "yo" },
    ])
    expect(md).toContain("## your message")
    expect(md).toContain("hi")
    expect(md).toContain("## assistant message")
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
