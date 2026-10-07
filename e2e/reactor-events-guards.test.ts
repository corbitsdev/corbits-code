import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";

import { onTurnBoundary } from "../src/agent/reactor-events.js";
import { createPermissionGate } from "../src/permission/gate.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilDone,
} from "./integration-harness.js";

// Pins onTurnBoundary against a real reactor's emitted events; the unit
// tests in src/agent/reactor-events.test.ts cover type-level narrowing.
// onReactorShutdown is not exercised here: close() clears stream() consumers
// before the queued abort, so stream consumers cannot observe reactor.done
// after close() (run-sink.ts snapshots status before close for the same
// reason).
describe("integration — reactor-events guards", () => {
  test.serial(
    "onTurnBoundary matches exactly the turn boundary, once per real turn",
    async () => {
      const session = await openIntegrationSession({
        permissionGate: createPermissionGate({
          approvals: [],
          interactive: false,
          skipPermissions: true,
          reactorGated: false,
        }),
      });

      try {
        session.harness.scenario.replyOnce("anthropic", {
          toolCalls: [
            { name: "write_file", args: { path: "out.txt", content: "ok\n" } },
          ],
        });
        session.harness.scenario.replyOnce("anthropic", { text: "Done." });

        const { events } = await runUntilDone(
          session,
          "Write out.txt with content ok.",
        );

        const turnBoundaries = events.filter(onTurnBoundary);

        // One tool-call turn plus one final-text turn: exactly two inference.done events.
        expect(turnBoundaries.length).toBe(2);
        expect(
          turnBoundaries.every(
            (e: ReactorEmittedEvent) => e.type === "inference.done",
          ),
        ).toBe(true);
        expect(events.some((e) => e.type === "tool.done")).toBe(true);
      } finally {
        await closeIntegrationSession(session);
      }
    },
  );
});
