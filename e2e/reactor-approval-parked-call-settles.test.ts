/**
 * A parked call that ends without running is answered by the reactor with a
 * synthetic error result and no `tool.done`. These tests capture the real
 * reactor's event stream for a rejected and an approved parked call and replay
 * it into the TUI bridge, so the bridge is judged against what the reactor
 * actually emits rather than a hand-written sequence.
 */
import { describe, expect, test } from "bun:test";

import type { ReactorEmittedEvent } from "@intx/inference";

import { createPermissionGate } from "../src/permission/gate.js";
import { createReactorAuthorize } from "../src/permission/reactor-authorize.js";
import {
  createApprovalResume,
  resolveParkedCallIdFromStore,
} from "../src/session/approval-resume.js";
import {
  attachSessionBridge,
  createRecordingPort,
  PARKED_CALL_NOT_RUN,
} from "../src/tui/runtime-bridge.js";
import { withAppShell } from "../src/tui/test-helpers.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  runUntilSuspended,
  toolDoneEvents,
} from "./integration-harness.js";

/** Drives one parked call to the operator's decision; returns every event. */
async function parkedCallEvents(
  allow: boolean,
): Promise<ReactorEmittedEvent[]> {
  let release: ((outcome: { allow: boolean }) => void) | undefined;
  const gate = createPermissionGate({
    approvals: [],
    interactive: true,
    skipPermissions: false,
    auto: false,
    reactorGated: true,
    requestApproval: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const session = await openIntegrationSession({
    permissionGate: gate,
    authorize: createReactorAuthorize(gate),
  });
  try {
    session.harness.scenario.replyOnce("anthropic", {
      toolCalls: [
        {
          name: "run_shell",
          args: { command: "curl -sS https://example.com" },
        },
      ],
    });
    session.harness.scenario.replyOnce("anthropic", { text: "Understood." });

    const turn = await runUntilSuspended(session, "Fetch example.com.");
    if (turn.result.type !== "suspended") throw new Error("did not park");
    const resume = createApprovalResume({
      getAgent: () => session.agent,
      gate,
      resolveParkedCallId: (correlationId) =>
        resolveParkedCallIdFromStore(session.storage, correlationId),
    });
    const handling = resume.handle(turn.result);
    for (let i = 0; i < 400 && release === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release?.({ allow });
    await handling;
    await turn.reply();
    // Let the run-ended event that follows the reply land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return [...turn.events];
  } finally {
    await closeIntegrationSession(session);
  }
}

async function replayIntoBridge(events: readonly ReactorEmittedEvent[]) {
  let outcome:
    | {
        run: string;
        active: readonly string[];
        rows: { text: string; failed?: boolean; pending?: boolean }[];
      }
    | undefined;
  await withAppShell(
    (shell) => {
      const bridge = attachSessionBridge(shell, createRecordingPort());
      try {
        for (const event of events) {
          bridge.handle(event as { type: string; data?: unknown });
        }
        outcome = {
          run: shell.session.run,
          active: bridge.turn.activeToolCalls,
          rows: shell.streamLog.filter(
            (row) => row.role === "tool",
          ) as unknown as {
            text: string;
            failed?: boolean;
            pending?: boolean;
          }[],
        };
      } finally {
        bridge.dispose();
      }
    },
    { shell: { run: "busy" } },
  );
  if (outcome === undefined) throw new Error("bridge did not run");
  return outcome;
}

describe("integration: a parked call's end settles the TUI turn", () => {
  test.serial(
    "a rejected call emits no tool.done, and the bridge still closes it and settles",
    async () => {
      const events = await parkedCallEvents(false);
      // The premise of the fix: nothing on the stream names the parked call.
      expect(toolDoneEvents(events)).toHaveLength(0);

      const after = await replayIntoBridge(events);
      expect(after.active).toEqual([]);
      expect(after.run).toBe("idle");
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.failed).toBe(true);
      expect(after.rows[0]?.text).toBe(PARKED_CALL_NOT_RUN);
    },
  );

  test.serial(
    "an approved call reports its own result and is not closed as not run",
    async () => {
      const events = await parkedCallEvents(true);
      expect(toolDoneEvents(events)).toHaveLength(1);

      const after = await replayIntoBridge(events);
      expect(after.active).toEqual([]);
      expect(after.run).toBe("idle");
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.text).not.toBe(PARKED_CALL_NOT_RUN);
    },
  );
});
