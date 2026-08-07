import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { ReactorInboundEvent } from "@intx/types/runtime";
import { onReactorShutdown, onTurnBoundary } from "./reactor-events.js";

// Bare `{ type: string }` literals only prove the string comparison works.
// The generic exists so the guards narrow across both `ReactorInboundEvent`
// (the director-facing union, `src/agent/director.ts` / `compaction.ts`) and
// `ReactorEmittedEvent` (the stream-facing union consumers see) without
// redeclaring either union in `reactor-events.ts`. These tests drive real
// members of both unions through the guards so a future change that breaks
// narrowing on either union — e.g. a renamed variant, or the guard's
// signature drifting to accept only one union — fails here instead of
// surfacing as a silent `never` match downstream.

// `reactor.done` is emitted-only: it does not exist on `ReactorInboundEvent`
// at all, so `onReactorShutdown` narrows to `never` for every director-side
// event. That is exactly the distinction the doc and the guard both draw
// ("did a turn end" is a question directors ask; "did the reactor shut
// down" is not), and it is a fact the integration harness cannot exercise
// on its own — the agent stream never hands a `ReactorInboundEvent` to
// application code, only `ReactorEmittedEvent`.
const inboundEvents: ReactorInboundEvent[] = [
  {
    type: "message.received",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  } as unknown as ReactorInboundEvent,
  {
    type: "inference.done",
    turn: {},
    usage: {},
    source: {},
  } as unknown as ReactorInboundEvent,
  {
    type: "inference.error",
    error: {},
    partial: {},
  } as unknown as ReactorInboundEvent,
  { type: "tool.done", result: {} } as unknown as ReactorInboundEvent,
  {
    type: "reactor.gate.cleared",
    gateId: "g1",
    reason: "resolved",
  } as unknown as ReactorInboundEvent,
  { type: "abort", reason: {} } as unknown as ReactorInboundEvent,
];

const emittedEvents: ReactorEmittedEvent[] = [
  {
    type: "message.received",
    seq: 0,
    data: { message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  } as unknown as ReactorEmittedEvent,
  { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
  { type: "reactor.done", data: {} } as unknown as ReactorEmittedEvent,
  { type: "tool.done", data: {} } as unknown as ReactorEmittedEvent,
];

describe("onTurnBoundary", () => {
  test("narrows ReactorInboundEvent to exactly the inference.done member", () => {
    const matches = inboundEvents.filter(onTurnBoundary);
    expect(matches.map((e) => e.type)).toEqual(["inference.done"]);
    // Type-level: narrowing must land on the real union member, with its
    // real fields, not an unrelated shape — this line fails to compile if
    // onTurnBoundary stops narrowing E correctly.
    const [narrowed] = matches;
    const _turn: unknown = narrowed?.turn;
    void _turn;
  });

  test("narrows ReactorEmittedEvent to exactly the inference.done member", () => {
    const matches = emittedEvents.filter(onTurnBoundary);
    expect(matches.map((e) => e.type)).toEqual(["inference.done"]);
  });

  // The property all three shipped defects violated: code that gated a
  // turn boundary on `reactor.done` only ever saw it once, at shutdown.
  // A multi-turn session must trip this guard once per turn.
  test("fires more than once across a multi-turn stream of real events", () => {
    const turnEvents: ReactorEmittedEvent[] = [
      { type: "inference.start", data: {} } as unknown as ReactorEmittedEvent,
      { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
      { type: "tool.done", data: {} } as unknown as ReactorEmittedEvent,
      { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
      { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
    ];

    const boundaries = turnEvents.filter(onTurnBoundary);

    expect(boundaries.length).toBe(3);
    expect(boundaries.length).toBeGreaterThan(1);
  });
});

describe("onReactorShutdown", () => {
  test("never matches any ReactorInboundEvent member — reactor.done is emitted-only", () => {
    const matches = inboundEvents.filter(onReactorShutdown);
    expect(matches).toEqual([]);
  });

  test("narrows ReactorEmittedEvent to exactly the reactor.done member, once per session", () => {
    const sessionEvents: ReactorEmittedEvent[] = [
      { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
      { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
      { type: "inference.done", data: {} } as unknown as ReactorEmittedEvent,
      { type: "reactor.done", data: {} } as unknown as ReactorEmittedEvent,
    ];

    const matches = emittedEvents.filter(onReactorShutdown);
    expect(matches.map((e) => e.type)).toEqual(["reactor.done"]);

    const shutdowns = sessionEvents.filter(onReactorShutdown);
    expect(shutdowns.length).toBe(1);
  });
});
