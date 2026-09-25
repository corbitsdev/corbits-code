import { describe, expect, test } from "bun:test";
import {
  createFleetMailbox,
  createSpawnAgentTool,
  createWaitAgentsTool,
  waitAgentsToolDefinition,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import { unlimitedAdmissionQueue } from "./admission.js";
import { isLiveWaitStatus } from "./lifecycle.js";
import {
  driveMailboxMail,
  occupancyShouldYieldWait,
} from "./mailbox-mail-drive.js";
import { createResolvedProviderFailureError } from "../inference-error-message.js";
import { createPermissionGate } from "../permission/gate.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

function makeDeps(
  run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>,
): AgentFleetDeps {
  const sessions = createSubAgentSessionStore();
  return {
    permissionGate: testPermissionGate,
    cwd: "/tmp",
    getWorkdirBase: () => "/tmp/workdir",
    provider,
    run,
    sessions,
    fleetRecords: createFleetMailbox(sessions),
    admission: unlimitedAdmissionQueue(),
  };
}

async function callToolRaw(
  tool:
    | ReturnType<typeof createSpawnAgentTool>
    | ReturnType<typeof createWaitAgentsTool>,
  args: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  if (tool.kind !== "full")
    throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    {
      id: `call-${Math.random()}`,
      name: tool.definition.name,
      arguments: args,
    },
    new AbortController().signal,
  );
  const content =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.content);
  return {
    content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

async function callTool(
  tool:
    | ReturnType<typeof createSpawnAgentTool>
    | ReturnType<typeof createWaitAgentsTool>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { content } = await callToolRaw(tool, args);
  return JSON.parse(content) as Record<string, unknown>;
}

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

function waitUntilMailboxTerminal(
  mailbox: ReturnType<typeof createFleetMailbox>,
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  id: string,
): Promise<void> {
  return new Promise((resolve) => {
    const done = (): boolean => {
      const snap = mailbox.peek(id);
      return snap !== undefined && !isLiveWaitStatus(snap.status);
    };
    if (done()) {
      resolve();
      return;
    }
    const unsub = sessions.subscribe(() => {
      if (done()) {
        unsub();
        resolve();
      }
    });
    if (done()) {
      unsub();
      resolve();
    }
  });
}

describe("CL-8978 recoverable subagent failure", () => {
  test("retryable-after-tools failure is wait-terminal failed with a continuable marker, and the parent can spawn/wait a successor", async () => {
    const deps = makeDeps(async () => {
      throw retryableAfterToolsFailure();
    });
    const spawn = createSpawnAgentTool(deps);
    const wait = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });

    const spawned = await callTool(spawn, {
      description: "flaky job",
      prompt: "do it",
      intent: "explore",
    });
    const id = spawned.agent_id as string;
    expect(typeof id).toBe("string");

    const waited = await callTool(wait, {
      targets: [id],
      timeout_ms: 5000,
      mode: "all",
    });
    expect(waited.timed_out).toBe(false);
    const results = waited.results as Record<string, unknown>[];
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("failed");
    expect(typeof results[0]?.error).toBe("string");
    // Machine-readable continuable marker plus single-successor guidance.
    expect(results[0]?.continuable).toBe(true);
    expect(typeof results[0]?.continue_with).toBe("string");

    // The failure is terminal, never stuck running.
    const snap = deps.fleetRecords.peek(id);
    expect(snap?.status).toBe("failed");
    expect(isLiveWaitStatus(snap?.status ?? "running")).toBe(false);

    // The parent handle still works: spawn and wait a successor.
    const deps2 = makeDeps(async () => ({ report: "successor done" }));
    // Share the fleet so the successor is a true sibling lane.
    const spawn2 = createSpawnAgentTool({ ...deps2, sessions: deps.sessions, fleetRecords: deps.fleetRecords });
    const wait2 = createWaitAgentsTool({
      sessions: deps.sessions,
      fleetRecords: deps.fleetRecords,
    });
    const spawned2 = await callTool(spawn2, {
      description: "successor job",
      prompt: "do it again",
      intent: "explore",
    });
    const id2 = spawned2.agent_id as string;
    expect(id2).not.toBe(id);
    const waited2 = await callTool(wait2, {
      targets: [id2],
      timeout_ms: 5000,
      mode: "all",
    });
    expect(waited2.timed_out).toBe(false);
    const results2 = waited2.results as Record<string, unknown>[];
    expect(results2[0]?.status).toBe("done");
  });

  test("credential failure stays failed without a continuable marker", async () => {
    const deps = makeDeps(async () => {
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

    const spawned = await callTool(spawn, {
      description: "auth job",
      prompt: "do it",
      intent: "explore",
    });
    const waited = await callTool(wait, {
      targets: [spawned.agent_id as string],
      timeout_ms: 5000,
      mode: "all",
    });
    const results = waited.results as Record<string, unknown>[];
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.continuable).toBeUndefined();
  });

  test("failed+recoverable lane is delivered as mailbox mail, and a failed send re-arms instead of dropping the terminal", async () => {
    const deps = makeDeps(async () => {
      throw retryableAfterToolsFailure();
    });
    const spawn = createSpawnAgentTool(deps);
    const spawned = await callTool(spawn, {
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
  });

  test("wait_agents documents the continuable failed marker", () => {
    expect(waitAgentsToolDefinition.description).toContain("continuable");
  });
});
