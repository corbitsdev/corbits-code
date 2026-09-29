import { describe, expect, test } from "bun:test";

import {
  createFleetMailbox,
  createSpawnAgentTool,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import { unlimitedAdmissionQueue } from "./admission.js";
import { createPermissionGate } from "../permission/gate.js";
import { NOOP_TELEMETRY, type TelemetryEvent } from "../telemetry/index.js";
import type { AgentProfile } from "../agent/profiles.js";
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

const READ_ONLY_PROFILE: AgentProfile = {
  id: "read-only-worker",
  systemPromptRole: "You read files.",
  capabilities: { mode: "allow", tools: ["read_file"] },
};

function makeDeps(
  run: (params: RunSubAgentParams) => Promise<RunSubAgentResult>,
  capturedTelemetry: TelemetryEvent[],
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
    profiles: [READ_ONLY_PROFILE],
    telemetry: {
      ...NOOP_TELEMETRY,
      capture: (event: TelemetryEvent) => {
        capturedTelemetry.push(event);
      },
    },
  };
}

async function callSpawn(
  tool: ReturnType<typeof createSpawnAgentTool>,
  args: Record<string, unknown>,
): Promise<{ content: string; isError?: boolean }> {
  if (tool.kind !== "full") throw new Error("expected full tool");
  const result = await tool.handler(
    {
      id: `spawn-${Math.random()}`,
      name: "spawn_agent",
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

describe("spawn_agent requires_tools preflight", () => {
  test("rejects a tool outside the allowlist with no session, telemetry, or run", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    const deps = makeDeps(async () => {
      runCalled = true;
      return { report: "done" };
    }, telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "shell job",
      prompt: "run a command",
      agent: "read-only-worker",
      requires_tools: ["run_shell"],
    });

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("Error:")).toBe(true);
    expect(result.content).toContain("run_shell");
    expect(result.content).toContain("Re-dispatch");
    expect(result.content).not.toContain("continuable");
    expect(runCalled).toBe(false);
    expect(deps.sessions.list()).toEqual([]);
    expect(telemetry).toEqual([]);
  });

  test("rejects an unknown tool with a did-you-mean hint and no session", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    const deps = makeDeps(async () => {
      runCalled = true;
      return { report: "done" };
    }, telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "typo job",
      prompt: "do it",
      agent: "read-only-worker",
      requires_tools: ["run_shel"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Did you mean "run_shell"?');
    expect(runCalled).toBe(false);
    expect(deps.sessions.list()).toEqual([]);
    expect(telemetry).toEqual([]);
  });

  test("accepts a mounted tool and stamps the session record", async () => {
    const telemetry: TelemetryEvent[] = [];
    let seenRequires: readonly string[] | undefined;
    const deps = makeDeps(async (params) => {
      seenRequires = params.requiresTools;
      return { report: "done" };
    }, telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "read job",
      prompt: "read a file",
      agent: "read-only-worker",
      requires_tools: ["read_file"],
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as {
      agent_id: string;
      status: string;
    };
    const session = deps.sessions.get(body.agent_id);
    expect(session?.requiresTools).toEqual(["read_file"]);
    expect(typeof session?.snapshotRevision).toBe("number");
    expect(seenRequires).toEqual(["read_file"]);
    expect(telemetry).toContain("subagent_start");
  });

  test("aliases collapse at dispatch (shell stamps run_shell)", async () => {
    const telemetry: TelemetryEvent[] = [];
    const deps = makeDeps(async () => ({ report: "done" }), telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "alias read job",
      prompt: "read a file",
      agent: "read-only-worker",
      requires_tools: ["read"],
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as { agent_id: string };
    expect(deps.sessions.get(body.agent_id)?.requiresTools).toEqual([
      "read_file",
    ]);
  });

  test("omitted requires_tools leaves the session unstamped", async () => {
    const telemetry: TelemetryEvent[] = [];
    const deps = makeDeps(async () => ({ report: "done" }), telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "plain job",
      prompt: "read a file",
      agent: "read-only-worker",
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as { agent_id: string };
    const session = deps.sessions.get(body.agent_id);
    expect(session?.requiresTools).toBeUndefined();
    expect(session?.snapshotRevision).toBeUndefined();
  });
});
