import { describe, expect, test } from "bun:test"
import {
  createStreamMapContext,
  mapProductionEvent,
  mapProductionSequence,
  mapReactorLike,
} from "./stream-event-map.js"

describe("mapProductionEvent", () => {
  test("message.received → user text", () => {
    expect(
      mapProductionEvent({
        type: "message.received",
        data: { message: { content: "hello" } },
      }),
    ).toEqual([{ type: "user", text: "hello" }])
  })

  test("inference.start → busy run", () => {
    expect(mapProductionEvent({ type: "inference.start" })).toEqual([
      { type: "run", state: "busy" },
    ])
  })

  test("text deltas stream as assistant.delta", () => {
    const ctx = createStreamMapContext()
    expect(
      mapProductionEvent(
        { type: "inference.text.delta", data: { token: "Hi" } },
        ctx,
      ),
    ).toEqual([{ type: "assistant.delta", text: "Hi" }])
    expect(
      mapProductionEvent(
        { type: "inference.text.delta", data: { token: "!" } },
        ctx,
      ),
    ).toEqual([{ type: "assistant.delta", text: "!" }])
  })

  test("tool_call.start+end paints once with args (stateful)", () => {
    const ctx = createStreamMapContext()
    expect(
      mapProductionEvent(
        {
          type: "inference.tool_call.start",
          data: { name: "read_file", callId: "c1" },
        },
        ctx,
      ),
    ).toEqual([])
    expect(
      mapProductionEvent(
        {
          type: "inference.tool_call.end",
          data: {
            name: "read_file",
            callId: "c1",
            arguments: { path: "a.ts" },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: "tool_call",
        name: "read_file",
        detail: JSON.stringify({ path: "a.ts" }),
      },
    ])
  })

  test("tool.done → tool_result + tool.boundary", () => {
    const out = mapProductionEvent({
      type: "tool.done",
      data: {
        result: {
          name: "read_file",
          content: "ok",
          isError: false,
        },
      },
    })
    expect(out).toEqual([
      { type: "tool_result", name: "read_file", detail: "ok" },
      { type: "tool.boundary" },
    ])
  })

  test("reactor.done → idle + boundary", () => {
    expect(mapProductionEvent({ type: "reactor.done" })).toEqual([
      { type: "run", state: "idle" },
      { type: "tool.boundary" },
    ])
  })

  test("connector.reply after deltas is skipped (already painted)", () => {
    const ctx = createStreamMapContext()
    mapProductionEvent(
      { type: "inference.text.delta", data: { token: "partial" } },
      ctx,
    )
    expect(
      mapProductionEvent(
        { type: "connector.reply", data: { content: "final answer" } },
        ctx,
      ),
    ).toEqual([])
  })

  test("connector.reply without prior deltas becomes assistant", () => {
    expect(
      mapProductionEvent({
        type: "connector.reply",
        data: { content: "final answer" },
      }),
    ).toEqual([{ type: "assistant", text: "final answer" }])
  })

  test("empty user content ignored", () => {
    expect(
      mapProductionEvent({
        type: "message.received",
        data: { message: { content: "   " } },
      }),
    ).toEqual([])
  })

  test("mapReactorLike matches stateless mapProductionEvent", () => {
    const ev = { type: "inference.start" as const }
    expect(mapReactorLike(ev)).toEqual(mapProductionEvent(ev))
  })

  test("mapProductionSequence folds context across events", () => {
    const out = mapProductionSequence([
      { type: "inference.start" },
      {
        type: "inference.tool_call.start",
        data: { name: "grep", callId: "t1" },
      },
      {
        type: "inference.tool_call.end",
        data: { name: "grep", callId: "t1", arguments: { q: "x" } },
      },
      {
        type: "tool.done",
        data: { result: { callId: "t1", name: "grep", content: "hits" } },
      },
      { type: "reactor.done" },
    ])
    expect(out.map((e) => e.type)).toEqual([
      "run",
      "tool_call",
      "tool_result",
      "tool.boundary",
      "run",
      "tool.boundary",
    ])
  })
})
