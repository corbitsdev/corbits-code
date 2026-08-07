import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { onTurnBoundary } from "../../src/agent/reactor-events.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import { closeIntegrationSession, openIntegrationSession, runUntilDone } from "./harness.js";

// The unit tests in `src/agent/reactor-events.test.ts` cover type-level
// narrowing across both event unions and `onReactorShutdown`'s behavior.
// This test asserts the property `onTurnBoundary` exists for — it matches
// exactly once per turn — against a real reactor's real emitted events,
// not a synthetic filtered array of hand-built literals.
//
// `onReactorShutdown` is not exercised here: `@intx/agent`'s `close()`
// clears `stream()` consumers synchronously, before the queued abort that
// produces `reactor.done` is processed, so application code attached via
// `agent.stream()` cannot observe it after `close()` — the same reason
// `src/session/run-sink.ts` snapshots status *before* close instead of
// relying on `reactor.done` to arrive. That gap is covered by the unit
// test's real `ReactorEmittedEvent` / `ReactorInboundEvent` narrowing.
describe("integration — reactor-events guards", () => {
  test.serial("onTurnBoundary matches exactly the turn boundary, once per real turn", async () => {
    const session = await openIntegrationSession({
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
      }),
    });

    try {
      session.harness.scenario.replyOnce("anthropic", {
        toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "ok\n" } }],
      });
      session.harness.scenario.replyOnce("anthropic", { text: "Done." });

      const { events } = await runUntilDone(session, "Write out.txt with content ok.");

      const turnBoundaries = events.filter(onTurnBoundary);

      // One tool-call turn followed by one final-text turn: exactly two
      // inference.done events, despite tool.done and other events on the stream.
      expect(turnBoundaries.length).toBe(2);
      expect(turnBoundaries.every((e: ReactorEmittedEvent) => e.type === "inference.done")).toBe(
        true,
      );
      expect(events.some((e) => e.type === "tool.done")).toBe(true);
    } finally {
      await closeIntegrationSession(session);
    }
  });
});
