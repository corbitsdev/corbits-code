import { describe, expect, test } from "bun:test";
import { createSpawnAgentTool, createWaitAgentsTool } from "./agent-fleet.js";
import { isLiveWaitStatus } from "./lifecycle.js";
import {
  driveMailboxMail,
  occupancyShouldYieldWait,
} from "./mailbox-mail-drive.js";
import { createResolvedProviderFailureError } from "../inference-error-message.js";
import type { RunSubAgentResult } from "./types.js";
import {
  callFleetTool,
  createFleetDeps,
  deferred,
  waitUntilMailboxTerminal,
} from "./fleet-test-harness.js";

function retryableAfterToolsFailure(): Error {
  // runSubAgentInner throws without an outer retry once any tool already ran,
  // so a retryable provider fault after tool use lands in the agent-fleet
  // catch as a ResolvedProviderFailureError with category "retryable".
  return createResolvedProviderFailureError("test-provider", {
    category: "retryable",
    message: "upstream overloaded, retry later",
    statusCode: 429,
  });
}

describe("CL-8978 recoverable subagent failure", () => {
  // The full retryable-after-tools scenario (failed lane, continuable
  // marker, parent not stalled) runs end-to-end in
  // e2e/subagent-recoverable-failure.test.ts. The cases below stay
  // unit-level: they exercise mailbox/deliver seams below e2e granularity.
  test("credential failure stays failed without a continuable marker", async () => {
    const deps = createFleetDeps(async () => {
      throw createResolvedProviderFailureError("test-provider", {
        category: "credential_failure",
        message: "Authentication failed",
        statusCode: 401,
      });
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callFleetTool(spawn, {
      description: "auth job",
      prompt: "do it",
      intent: "explore",
    });
    const waited = await callFleetTool(wait, {
      targets: [spawned.agent_id as string],
      timeout_ms: 5000,
      mode: "all",
    });
    const results = waited.results as Record<string, unknown>[];
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.continuable).toBeUndefined();
  });

  test("failed+recoverable lane is delivered as mailbox mail, and a failed send re-arms instead of dropping the terminal", async () => {
    const deps = createFleetDeps(async () => {
      throw retryableAfterToolsFailure();
    });
    const spawn = createSpawnAgentTool(deps);
    const spawned = await callFleetTool(spawn, {
      description: "flaky job",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    await waitUntilMailboxTerminal(deps.fleetRecords, deps.sessions, id);

    // Terminal failure is occupancy-yielding, so the parent is driven back
    // into a turn instead of sitting silent for the stall bound.
    expect(occupancyShouldYieldWait(deps.fleetRecords)).toBe(true);

    const prompts: string[] = [];
    let sendShouldFail = true;
    const drive = (): boolean | Promise<boolean> =>
      driveMailboxMail({
        parentProcessing: false,
        mailbox: deps.fleetRecords,
        lanes: deps.sessions.list(),
        beginSystemContinuation: () => undefined,
        send: (prompt: string) => {
          prompts.push(prompt);
          if (sendShouldFail) throw new Error("send down");
          return { status: "accepted" };
        },
      });

    // Occupancy send failure leaves the terminal uncollected ...
    expect(await drive()).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(id);
    expect(deps.fleetRecords.peek(id)?.collected).not.toBe(true);

    // ... and the re-flush delivers it, starting the parent turn.
    sendShouldFail = false;
    expect(await drive()).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(deps.fleetRecords.peek(id)?.collected).toBe(true);
    // The mailbox path carries the same continuable marker as wait_agents.
    expect(prompts[1]).toContain('"continuable":true');
  });

  test("in-flight work stays live until settled: a timeout is liveness, not failure", async () => {
    const gate = deferred<RunSubAgentResult>();
    const deps = createFleetDeps(() => gate.promise);
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callFleetTool(spawn, {
      description: "slow job",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;

    // Unsettled work (including an in-flight provider retry) projects live.
    const snap = deps.fleetRecords.peek(id);
    expect(snap?.status).toBe("running");
    expect(isLiveWaitStatus(snap?.status ?? "failed")).toBe(true);

    const waited = await callFleetTool(wait, {
      targets: [id],
      timeout_ms: 50,
      mode: "all",
    });
    expect(waited.timed_out).toBe(true);
    const results = waited.results as Record<string, unknown>[];
    expect(results[0]?.status).toBe("running");
    expect(results[0]?.continuable).toBeUndefined();

    gate.resolve({ report: "slow done" });
    const waited2 = await callFleetTool(wait, {
      targets: [id],
      timeout_ms: 5000,
      mode: "all",
    });
    expect(waited2.timed_out).toBe(false);
    const results2 = waited2.results as Record<string, unknown>[];
    expect(results2[0]?.status).toBe("done");
  });
});
