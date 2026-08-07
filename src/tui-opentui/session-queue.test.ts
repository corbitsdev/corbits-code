import { describe, expect, test } from "bun:test"
import {
  badgeCount,
  cancelLast,
  clearInterruptFlash,
  createSessionQueue,
  drainOne,
  drainOrder,
  enqueue,
  enqueueSteer,
  interrupt,
  setRunState,
} from "./session-queue"

describe("session-queue", () => {
  test("empty enqueue is no-op", () => {
    const s0 = createSessionQueue("busy")
    expect(enqueue(s0, "   ")).toBe(s0)
    expect(badgeCount(s0)).toBe(0)
  })

  test("Enter path enqueues; badge increments", () => {
    let s = createSessionQueue("busy")
    s = enqueue(s, "hello")
    s = enqueue(s, "world")
    expect(badgeCount(s)).toBe(2)
    expect(s.items.map((i) => i.kind)).toEqual(["queue", "queue"])
    expect(s.items[0]!.text).toBe("hello")
  })

  test("Alt+Enter path steers; same badge pool", () => {
    let s = createSessionQueue("busy")
    s = enqueue(s, "later")
    s = enqueueSteer(s, "asap")
    expect(badgeCount(s)).toBe(2)
    expect(s.items[1]!.kind).toBe("steer")
  })

  test("drain order: steers before queue", () => {
    let s = createSessionQueue("busy")
    s = enqueue(s, "q1")
    s = enqueueSteer(s, "s1")
    s = enqueue(s, "q2")
    s = enqueueSteer(s, "s2")
    expect(drainOrder(s).map((i) => i.text)).toEqual(["s1", "s2", "q1", "q2"])

    const d1 = drainOne(s)
    expect(d1.item?.text).toBe("s1")
    const d2 = drainOne(d1.state)
    expect(d2.item?.text).toBe("s2")
    const d3 = drainOne(d2.state)
    expect(d3.item?.text).toBe("q1")
  })

  test("Ctrl+C interrupt clears pending + sets flash + idle", () => {
    let s = createSessionQueue("busy")
    s = enqueue(s, "a")
    s = enqueueSteer(s, "b")
    s = interrupt(s)
    expect(badgeCount(s)).toBe(0)
    expect(s.interruptFlash).toBe(true)
    expect(s.run).toBe("idle")
    s = clearInterruptFlash(s)
    expect(s.interruptFlash).toBe(false)
  })

  test("cancelLast retracts the newest queue item", () => {
    let s = createSessionQueue("busy")
    s = enqueue(s, "keep")
    s = enqueue(s, "drop")
    const { state, item } = cancelLast(s)
    expect(item?.text).toBe("drop")
    expect(badgeCount(state)).toBe(1)
    expect(state.items[0]!.text).toBe("keep")
  })

  test("cancelLast retracts the newest steer item, same as queue", () => {
    let s = createSessionQueue("busy")
    s = enqueue(s, "queued")
    s = enqueueSteer(s, "steered")
    const { state, item } = cancelLast(s)
    expect(item?.kind).toBe("steer")
    expect(item?.text).toBe("steered")
    expect(badgeCount(state)).toBe(1)
    expect(state.items[0]!.kind).toBe("queue")
  })

  test("cancelLast on an empty queue is a no-op", () => {
    const s = createSessionQueue("busy")
    const { state, item } = cancelLast(s)
    expect(item).toBeNull()
    expect(state).toBe(s)
  })

  test("setRunState toggles busy/idle", () => {
    let s = createSessionQueue("idle")
    s = setRunState(s, "busy")
    expect(s.run).toBe("busy")
    s = setRunState(s, "busy")
    expect(s.run).toBe("busy")
  })
})
