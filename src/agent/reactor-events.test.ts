import { describe, expect, test } from "bun:test";
import { onReactorShutdown, onTurnBoundary } from "./reactor-events.js";

describe("onTurnBoundary", () => {
  test("true only for inference.done", () => {
    expect(onTurnBoundary({ type: "inference.done" })).toBe(true);
    expect(onTurnBoundary({ type: "reactor.done" })).toBe(false);
    expect(onTurnBoundary({ type: "tool.done" })).toBe(false);
  });

  // The property all three shipped defects violated: code that gated a
  // turn boundary on `reactor.done` only ever saw it once, at shutdown.
  // A multi-turn session must trip this guard once per turn.
  test("fires more than once across a multi-turn session", () => {
    const turnEvents = [
      { type: "inference.start" },
      { type: "inference.done" },
      { type: "tool.done" },
      { type: "inference.done" },
      { type: "inference.done" },
    ];

    const boundaries = turnEvents.filter((event) => onTurnBoundary(event));

    expect(boundaries.length).toBe(3);
    expect(boundaries.length).toBeGreaterThan(1);
  });
});

describe("onReactorShutdown", () => {
  test("true only for reactor.done, and fires once per session", () => {
    const sessionEvents = [
      { type: "inference.done" },
      { type: "inference.done" },
      { type: "inference.done" },
      { type: "reactor.done" },
    ];

    expect(onReactorShutdown({ type: "reactor.done" })).toBe(true);
    expect(onReactorShutdown({ type: "inference.done" })).toBe(false);

    const shutdowns = sessionEvents.filter((event) => onReactorShutdown(event));
    expect(shutdowns.length).toBe(1);
  });
});
