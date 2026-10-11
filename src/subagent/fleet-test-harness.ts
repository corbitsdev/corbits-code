/** Shared scaffolding for the fleet/session mailbox test suite. */
import { expect } from "bun:test";

import type { AgentTool } from "@intx/agent";

import { createPermissionGate } from "../permission/gate.js";
import {
  createFleetMailbox,
  createListAgentsTool,
  createSpawnAgentTool,
  createWaitAgentsTool,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import { unlimitedAdmissionQueue } from "./admission.js";
import { isLiveWaitStatus } from "./lifecycle.js";
import {
  createCloseAgentTool,
  createInterruptAgentTool,
  createResumeAgentTool,
  createSendInputTool,
} from "./lifecycle-tools.js";
import type {
  FleetDryLane,
  FleetDryMailbox,
  FleetDryMailboxRecord,
} from "./fleet-dry-drive.js";
import { createSubAgentSessionStore } from "./session-store.js";
import type { RunSubAgentParams, RunSubAgentResult } from "./types.js";

export const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

export const testProvider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createFleetDeps(
  run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>,
  opts: {
    cwd?: string;
    sessions?: ReturnType<typeof createSubAgentSessionStore>;
  } & Partial<Pick<AgentFleetDeps, "settings" | "catalog" | "profiles">> = {},
): AgentFleetDeps {
  const sessions = opts.sessions ?? createSubAgentSessionStore();
  return {
    permissionGate: testPermissionGate,
    cwd: opts.cwd ?? "/tmp",
    getWorkdirBase: () => "/tmp/workdir",
    provider: testProvider,
    run,
    sessions,
    fleetRecords: createFleetMailbox(sessions),
    admission: unlimitedAdmissionQueue(),
    ...(opts.settings !== undefined ? { settings: opts.settings } : {}),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
  };
}

/** Every fleet-scoped tool bound to one deps' sessions + fleetRecords. */
export function fleetTools(deps: AgentFleetDeps) {
  const scope = { sessions: deps.sessions, fleetRecords: deps.fleetRecords };
  return {
    spawn: createSpawnAgentTool(deps),
    wait: createWaitAgentsTool(scope),
    list: createListAgentsTool(scope),
    sendInput: createSendInputTool(scope),
    interrupt: createInterruptAgentTool(scope),
    close: createCloseAgentTool(scope),
    resume: createResumeAgentTool(scope),
  };
}

function waitForSessionNotify(
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  done: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
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

export function waitUntilMailboxTerminal(
  mailbox: ReturnType<typeof createFleetMailbox>,
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  id: string,
): Promise<void> {
  return waitForSessionNotify(sessions, () => {
    const snap = mailbox.peek(id);
    return snap !== undefined && !isLiveWaitStatus(snap.status);
  });
}

export function waitUntilAwaitingDirector(
  mailbox: ReturnType<typeof createFleetMailbox>,
  sessions: ReturnType<typeof createSubAgentSessionStore>,
  id: string,
): Promise<void> {
  return waitForSessionNotify(
    sessions,
    () => mailbox.peek(id)?.status === "awaiting_director",
  );
}

/** Fleet tool content is pretty-printed JSON; parse asserts the contract. */
export function parseFleetJson(content: string): Record<string, unknown> {
  expect(content).toContain("\n");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  expect(JSON.stringify(parsed, null, 2)).toBe(content);
  return parsed;
}

export async function callFleetToolRaw(
  tool: AgentTool,
  args: Record<string, unknown>,
  callId = `call-${Math.random()}`,
): Promise<{ content: string; isError?: boolean }> {
  if (tool.kind !== "full")
    throw new Error(`expected full tool, got ${tool.kind}`);
  const result = await tool.handler(
    {
      id: callId,
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

export async function callFleetTool(
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { content } = await callFleetToolRaw(tool, args);
  return parseFleetJson(content);
}

/** Spawn a worker and return its agent_id. */
export async function spawnAgentId(
  spawn: AgentTool,
  args: Record<string, unknown>,
): Promise<string> {
  const spawned = await callFleetTool(spawn, args);
  const id = spawned.agent_id;
  if (typeof id !== "string") throw new Error("missing agent_id");
  return id;
}

/** Spawn N workers and return their agent_ids in order. */
export async function spawnAgentIds(
  spawn: AgentTool,
  count: number,
  argsFor: (i: number) => Record<string, unknown> = () => ({}),
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(await spawnAgentId(spawn, argsFor(i)));
  }
  return ids;
}

/** Map-backed FleetDryMailbox whose take() peeks without marking collected. */
export function peekMailbox(
  records: Map<string, FleetDryMailboxRecord>,
): FleetDryMailbox {
  return {
    ids: () => [...records.keys()],
    peek: (id) => records.get(id),
    take: (id) => records.get(id),
  };
}

/** Map-backed FleetDryMailbox whose take() stamps collected, like the real one. */
export function collectingMailbox(
  records: Map<string, FleetDryMailboxRecord>,
): FleetDryMailbox {
  return {
    ids: () => [...records.keys()],
    peek: (id) => records.get(id),
    take: (id) => {
      const existing = records.get(id);
      if (existing === undefined) return undefined;
      const taken = { ...existing, collected: true };
      records.set(id, taken);
      return taken;
    },
  };
}

export const ACCEPTED_DELIVERY = { status: "accepted" as const };
export const NOT_DELIVERED_RESULT = {
  status: "not-delivered" as const,
  reason: "agent-closed" as const,
  detail: "agent closed",
};
export const UNCERTAIN_DELIVERY = {
  status: "uncertain" as const,
  detail: "send raced",
};

/** Shared arg block for driveMailboxMail/driveOpenTasksAfterFleetDry calls. */
export function driveFixture(
  records: Map<string, FleetDryMailboxRecord>,
  opts: {
    send?: (prompt: string) => unknown;
    begin?: (prompt: string) => void;
  } = {},
): {
  parentProcessing: boolean;
  mailbox: FleetDryMailbox;
  lanes: readonly FleetDryLane[];
  beginSystemContinuation: (prompt: string) => void;
  send: (prompt: string) => unknown;
} {
  return {
    parentProcessing: false,
    mailbox: collectingMailbox(records),
    lanes: [],
    beginSystemContinuation: opts.begin ?? (() => undefined),
    send: opts.send ?? (() => ACCEPTED_DELIVERY),
  };
}

/** driveFixture variant that records begin/send ordering and sent prompts. */
export function orderingDrive(
  records: Map<string, FleetDryMailboxRecord>,
  order: string[],
  sent: string[],
) {
  return driveFixture(records, {
    begin: (prompt) => {
      order.push("begin");
      sent.push(prompt);
    },
    send: (prompt) => {
      order.push("send");
      sent.push(prompt);
      return ACCEPTED_DELIVERY;
    },
  });
}
