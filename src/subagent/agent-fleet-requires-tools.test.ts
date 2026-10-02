import { describe, expect, test } from "bun:test";

import { stringTool, type AgentTool } from "@intx/agent";
import {
  createFleetMailbox,
  createSpawnAgentTool,
  tierGateRequiresTools,
  type AgentFleetDeps,
} from "./agent-fleet.js";
import { formatCapabilityUnavailable } from "./capability-preflight.js";
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

const FULL_MOUNT_PROFILE: AgentProfile = {
  id: "full-worker",
  systemPromptRole: "You do anything.",
};

// BUILD_TOOLS-like envelope: built-ins only, no MCP names.
const BUILD_LIKE_PROFILE: AgentProfile = {
  id: "build-worker",
  systemPromptRole: "You build.",
  capabilities: { mode: "allow", tools: ["read_file", "run_shell"] },
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
    profiles: [READ_ONLY_PROFILE, FULL_MOUNT_PROFILE],
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
    expect("snapshotRevision" in (session ?? {})).toBe(false);
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
    expect("snapshotRevision" in (session ?? {})).toBe(false);
  });

  test("manage_tasks survives dispatch under a narrow allowlist and stamps canonically", async () => {
    const telemetry: TelemetryEvent[] = [];
    let seenRequires: readonly string[] | undefined;
    const deps = makeDeps(async (params) => {
      seenRequires = params.requiresTools;
      return { report: "done" };
    }, telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "plan job",
      prompt: "track the work",
      agent: "read-only-worker",
      requires_tools: ["manage_tasks"],
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as { agent_id: string };
    expect(deps.sessions.get(body.agent_id)?.requiresTools).toEqual([
      "manage_tasks",
    ]);
    expect(seenRequires).toEqual(["manage_tasks"]);
  });

  test("update_plan alias survives dispatch and stamps manage_tasks", async () => {
    const telemetry: TelemetryEvent[] = [];
    const deps = makeDeps(async () => ({ report: "done" }), telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "alias plan job",
      prompt: "track the work",
      agent: "read-only-worker",
      requires_tools: ["update_plan"],
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content) as { agent_id: string };
    expect(deps.sessions.get(body.agent_id)?.requiresTools).toEqual([
      "manage_tasks",
    ]);
  });

  test("leaf requires_tools=[spawn_agent] rejects pre-spawn as missing_tool naming the leaf restriction", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    const deps = makeDeps(async () => {
      runCalled = true;
      return { report: "done" };
    }, telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "fleet job",
      prompt: "spawn more workers",
      agent: "full-worker",
      requires_tools: ["spawn_agent"],
    });

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("Error:")).toBe(true);
    expect(result.content).toContain("spawn_agent");
    expect(result.content).toContain("Tier 3 leaf");
    expect(result.content).toMatch(/Re-dispatch|drop the requirement/);
    expect(result.content).not.toContain("stale_snapshot");
    expect(runCalled).toBe(false);
    expect(deps.sessions.list()).toEqual([]);
    expect(telemetry).toEqual([]);
  });

  test("leaf requires_tools=[submit_result] passes preflight under a narrow allowlist (leaf reporting channel)", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    let seenRequires: readonly string[] | undefined;
    let seenTier: unknown;
    const deps = makeDeps(async (params) => {
      runCalled = true;
      seenRequires = params.requiresTools;
      seenTier = params.tier;
      return { report: "done" };
    }, telemetry);
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "leaf report job",
      prompt: "read a file and report",
      agent: "read-only-worker",
      requires_tools: ["submit_result"],
    });

    expect(result.isError).not.toBe(true);
    expect(runCalled).toBe(true);
    const body = JSON.parse(result.content) as { agent_id: string };
    expect(deps.sessions.get(body.agent_id)?.requiresTools).toEqual([
      "submit_result",
    ]);
    expect(seenRequires).toEqual(["submit_result"]);
    expect(seenTier).toBe("leaf");
  });

  test("mounted mcp__linear__ tool passes dispatch preflight under a built-ins-only allowlist", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    let seenRequires: readonly string[] | undefined;
    const linearTool: AgentTool = stringTool({
      definition: {
        name: "mcp__linear__list_teams",
        description: "Inherited Linear tool",
        inputSchema: {},
      },
      handler: async () => "teams",
    });
    const base = makeDeps(async (params) => {
      runCalled = true;
      seenRequires = params.requiresTools;
      return { report: "done" };
    }, telemetry);
    const deps: AgentFleetDeps = {
      ...base,
      profiles: [BUILD_LIKE_PROFILE],
      inheritMcpTools: () => [linearTool],
    };
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "linear job",
      prompt: "list teams",
      agent: "build-worker",
      requires_tools: ["mcp__linear__list_teams"],
    });

    expect(result.isError).not.toBe(true);
    expect(runCalled).toBe(true);
    const body = JSON.parse(result.content) as { agent_id: string };
    expect(deps.sessions.get(body.agent_id)?.requiresTools).toEqual([
      "mcp__linear__list_teams",
    ]);
    expect(seenRequires).toEqual(["mcp__linear__list_teams"]);
  });

  test("unmounted mcp__linear__ tool rejects dispatch preflight as unknown_tool with no run", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    const base = makeDeps(async () => {
      runCalled = true;
      return { report: "done" };
    }, telemetry);
    const deps: AgentFleetDeps = {
      ...base,
      profiles: [BUILD_LIKE_PROFILE],
    };
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "linear job",
      prompt: "list teams",
      agent: "build-worker",
      requires_tools: ["mcp__linear__list_teams"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('unknown tool "mcp__linear__list_teams"');
    expect(result.content).not.toContain("Did you mean");
    expect(runCalled).toBe(false);
    expect(deps.sessions.list()).toEqual([]);
    expect(telemetry).toEqual([]);
  });

  test("requires_tools stamps only the requested live tool, never the inherited set", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    let seenRequires: readonly string[] | undefined;
    const mcpTool = (name: string): AgentTool =>
      stringTool({
        definition: {
          name,
          description: `Inherited ${name}`,
          inputSchema: {},
        },
        handler: async () => name,
      });
    const base = makeDeps(async (params) => {
      runCalled = true;
      seenRequires = params.requiresTools;
      return { report: "done" };
    }, telemetry);
    const deps: AgentFleetDeps = {
      ...base,
      profiles: [BUILD_LIKE_PROFILE],
      inheritMcpTools: () => [
        mcpTool("mcp__linear__list_teams"),
        mcpTool("mcp__linear__create_issue"),
      ],
    };
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "linear job",
      prompt: "list teams",
      agent: "build-worker",
      requires_tools: ["mcp__linear__list_teams"],
    });

    // On-demand: dispatch stamps exactly the requested live tool — the
    // inherited sibling mounts only under its own stamp (run.ts drops it).
    expect(result.isError).not.toBe(true);
    expect(runCalled).toBe(true);
    expect(seenRequires).toEqual(["mcp__linear__list_teams"]);
  });

  test("requires_tools naming a live and an unmounted mcp__ tool rejects the unmounted one with no run", async () => {
    const telemetry: TelemetryEvent[] = [];
    let runCalled = false;
    const base = makeDeps(async () => {
      runCalled = true;
      return { report: "done" };
    }, telemetry);
    const deps: AgentFleetDeps = {
      ...base,
      profiles: [BUILD_LIKE_PROFILE],
      inheritMcpTools: () => [
        stringTool({
          definition: {
            name: "mcp__linear__list_teams",
            description: "Inherited Linear tool",
            inputSchema: {},
          },
          handler: async () => "teams",
        }),
      ],
    };
    const spawn = createSpawnAgentTool(deps);

    const result = await callSpawn(spawn, {
      description: "linear job",
      prompt: "list teams and file",
      agent: "build-worker",
      requires_tools: ["mcp__linear__list_teams", "mcp__linear__create_issue"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'unknown tool "mcp__linear__create_issue"',
    );
    expect(result.content).not.toContain("Did you mean");
    expect(runCalled).toBe(false);
    expect(deps.sessions.list()).toEqual([]);
    expect(telemetry).toEqual([]);
  });

  test("whitespace-only requires_tools rejects fail-closed with no session, telemetry, or run", async () => {
    for (const requiresTools of [["   "], ["read_file", "  "]]) {
      const telemetry: TelemetryEvent[] = [];
      let runCalled = false;
      const deps = makeDeps(async () => {
        runCalled = true;
        return { report: "done" };
      }, telemetry);
      const spawn = createSpawnAgentTool(deps);

      const result = await callSpawn(spawn, {
        description: "blank job",
        prompt: "do it",
        agent: "read-only-worker",
        requires_tools: requiresTools,
      });

      expect(result.isError).toBe(true);
      expect(result.content.startsWith("Error:")).toBe(true);
      expect(result.content).toContain("non-empty tool names");
      expect(runCalled).toBe(false);
      expect(deps.sessions.list()).toEqual([]);
      expect(telemetry).toEqual([]);
    }
  });
});

describe("tierGateRequiresTools", () => {
  test("leaf requiring a fleet verb rejects as missing_tool naming the leaf restriction", () => {
    const gated = tierGateRequiresTools(["spawn_agent"], "leaf");
    expect(gated?.code).toBe("missing_tool");
    expect(gated?.tool).toBe("spawn_agent");
    expect(gated?.detail).toContain("Tier 3 leaf");
  });

  test("orchestrator requiring a fleet verb passes", () => {
    expect(
      tierGateRequiresTools(["spawn_agent"], "orchestrator"),
    ).toBeUndefined();
    expect(
      tierGateRequiresTools(["spawn_agent"], "nested-orchestrator"),
    ).toBeUndefined();
  });

  test("nested-orchestrator requiring fleet discovery rejects pre-spawn", () => {
    const gated = tierGateRequiresTools(
      ["search_agents"],
      "nested-orchestrator",
    );
    expect(gated?.code).toBe("missing_tool");
    expect(gated?.detail).toContain("Tier 2");
  });

  test("non-leaf requiring the leaf reporting channel rejects pre-spawn", () => {
    for (const engine of ["submit_result", "ask_director"]) {
      const gated = tierGateRequiresTools([engine], "orchestrator");
      expect(gated?.code).toBe("missing_tool");
      expect(gated?.tool).toBe(engine);
      expect(gated?.detail).toContain("Tier 3 leaf workers only");
    }
  });

  test("tier-gated leaf channel names Tier 3 leaves instead of claiming no director mounts it", () => {
    const gated = tierGateRequiresTools(["submit_result"], "orchestrator");
    expect(gated?.alternatives ?? []).toEqual(["artist", "coder", "designer"]);
    const message = formatCapabilityUnavailable(
      gated ?? { code: "missing_tool", tool: "submit_result" },
      "test-orchestrator",
    );
    expect(message).toContain("Tier 3 leaf workers only");
    expect(message).toContain(
      "Re-dispatch to one of (artist, coder, designer)",
    );
    expect(message).not.toContain("No spawnable director mounts");
  });

  test("leaf requiring the leaf reporting channel passes", () => {
    expect(
      tierGateRequiresTools(["submit_result", "ask_director"], "leaf"),
    ).toBeUndefined();
  });

  test("ordinary tools pass on every tier", () => {
    for (const tier of [
      "leaf",
      "orchestrator",
      "nested-orchestrator",
    ] as const) {
      expect(
        tierGateRequiresTools(["read_file", "manage_tasks"], tier),
      ).toBeUndefined();
    }
  });
});
