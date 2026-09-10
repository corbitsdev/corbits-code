/**
 * authority.test.ts proves the assert functions throw when called directly,
 * which is necessary but not sufficient — it does not prove runSubAgent
 * itself cannot be talked into mounting a fleet verb for a caller whose tier
 * cannot be established. These tests drive runSubAgent (the real mount
 * point) end to end.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import { createPermissionGate } from "../permission/gate.js";
import { FleetAuthorityError } from "./authority.js";
import { runSubAgent } from "./run.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl6941-run-authority-"));
}

function baseParams(
  cwd: string,
  workdirBase: string,
  baseURL = "http://localhost",
): Omit<RunSubAgentParams, "orchestrator"> {
  return {
    cwd,
    workdirBase,
    permissionGate: testPermissionGate,
    provider: { providerName: "test", baseURL, model: "test-model" },
    description: "gate probe",
    prompt: "no-op",
  };
}

// Each mount-gate probe awaits a full runSubAgent cycle whose inference send
// fails after the mount decisions have run. The send used to target an
// unreachable host, whose connection-refused failure classifies as retryable
// — the client burned its full backoff schedule (three attempts with 500ms +
// 1000ms of fixed sleep) per test, enough to cross bun:test's 5s timeout
// whenever the randomized suite loaded the machine. A local server answering
// 401 fails the send as credential_failure, which is never retried, so the
// cycle costs one local round trip and no timing-sensitive waiting. The 15s
// per-test timeouts below only absorb machine-load spikes during the
// full-runtime construction these probes perform; assertions are
// timing-independent.
async function runWithFailingInference(
  run: (baseURL: string) => Promise<unknown>,
): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({ error: { message: "mount-gate probe provider" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
  });
  try {
    await run(server.url.origin);
  } finally {
    server.stop(true);
  }
}

describe("runSubAgent fleet-verb mount gate (CL-6941, fails closed)", () => {
  test("orchestrator=true with no resolvable tier (non-closed-director profile shape) is denied", async () => {
    const cwd = await tmpCwd();
    await expect(
      runSubAgent({
        ...baseParams(cwd, join(cwd, ".ctx")),
        orchestrator: true,
        // No directorId, no orchestratorTier — this is exactly the shape a
        // project/plugin AgentProfile with orchestrator: true produces.
        // nestedDispatch is deliberately omitted: the tier gate must reject
        // before that later "requires nestedDispatch" check is even reached.
      }),
    ).rejects.toBeInstanceOf(FleetAuthorityError);
  });

  test("orchestrator=true with an explicit leaf tier is denied", async () => {
    const cwd = await tmpCwd();
    await expect(
      runSubAgent({
        ...baseParams(cwd, join(cwd, ".ctx")),
        orchestrator: true,
        orchestratorTier: "leaf",
      }),
    ).rejects.toBeInstanceOf(FleetAuthorityError);
  });

  test("orchestrator=true with a resolved non-leaf tier passes the gate (fails later, not on authority)", async () => {
    const cwd = await tmpCwd();
    try {
      await runSubAgent({
        ...baseParams(cwd, join(cwd, ".ctx")),
        orchestrator: true,
        orchestratorTier: "nested-orchestrator",
        // Deliberately still omit nestedDispatch: a tier that passes the gate
        // must reach the *next* check (nestedDispatch required) instead of
        // being denied by assertTierMayMountFleetVerb.
      });
      throw new Error(
        "expected runSubAgent to reject (missing nestedDispatch)",
      );
    } catch (err) {
      expect(err).not.toBeInstanceOf(FleetAuthorityError);
      expect(String((err as Error).message)).toContain("nestedDispatch");
    }
  });
});

describe("runSubAgent search_agents mount gate (CL-7051, Tier-1 only)", () => {
  test("nested-orchestrator does not mount search_agents even when profiles exist", async () => {
    const cwd = await tmpCwd();
    let searchAgentsMounts = 0;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/agent-search.js"),
        (real: typeof import("../agent/agent-search.js")) => ({
          ...real,
          createSearchAgentsTool: (getProfiles: () => never) => {
            searchAgentsMounts++;
            return real.createSearchAgentsTool(getProfiles);
          },
        }),
        async () => {
          // Re-import so the mock is visible to runSubAgent's binding.
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
            id: "greybeard-session",
            orchestrator: true,
            orchestratorTier: "nested-orchestrator",
            nestedDispatch: {
              permissionGate: testPermissionGate,
              getWorkdirBase: () => join(cwd, ".ctx"),
              provider: { providerName: "test", baseURL, model: "test-model" },
              profiles: [{ id: "intern", systemPromptRole: "You are intern." }],
            },
          }).catch(() => {
            // Inference/agent construction may fail; mount decisions run first.
          });
        },
      ),
    );

    expect(searchAgentsMounts).toBe(0);
  }, 15_000);

  test("Tier-1 orchestrator mounts search_agents when profiles exist", async () => {
    const cwd = await tmpCwd();
    let searchAgentsMounts = 0;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("../agent/agent-search.js"),
        (real: typeof import("../agent/agent-search.js")) => ({
          ...real,
          createSearchAgentsTool: (getProfiles: () => never) => {
            searchAgentsMounts++;
            return real.createSearchAgentsTool(getProfiles);
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
            id: "skywalker-session",
            orchestrator: true,
            orchestratorTier: "orchestrator",
            nestedDispatch: {
              permissionGate: testPermissionGate,
              getWorkdirBase: () => join(cwd, ".ctx"),
              provider: { providerName: "test", baseURL, model: "test-model" },
              profiles: [{ id: "intern", systemPromptRole: "You are intern." }],
            },
          }).catch(() => {
            // Inference/agent construction may fail; mount decisions run first.
          });
        },
      ),
    );

    expect(searchAgentsMounts).toBe(1);
  }, 15_000);
});

describe("runSubAgent passes parentSessionId into spawn_agent mount", () => {
  test("nested orchestrator fleetDeps.parentSessionId equals params.id", async () => {
    const cwd = await tmpCwd();
    let capturedParentSessionId: string | undefined;
    let spawnMounts = 0;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("./agent-fleet.js"),
        (real: typeof import("./agent-fleet.js")) => ({
          ...real,
          createSpawnAgentTool: (
            deps: Parameters<typeof real.createSpawnAgentTool>[0],
          ) => {
            spawnMounts++;
            capturedParentSessionId = deps.parentSessionId;
            return real.createSpawnAgentTool(deps);
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
            id: "greybeard-session",
            orchestrator: true,
            orchestratorTier: "nested-orchestrator",
            nestedDispatch: {
              permissionGate: testPermissionGate,
              getWorkdirBase: () => join(cwd, ".ctx"),
              provider: { providerName: "test", baseURL, model: "test-model" },
              profiles: [{ id: "intern", systemPromptRole: "You are intern." }],
            },
          }).catch(() => {
            // Inference/agent construction may fail; mount decisions run first.
          });
        },
      ),
    );

    expect(spawnMounts).toBe(1);
    expect(capturedParentSessionId).toBe("greybeard-session");
  }, 15_000);
});

describe("runSubAgent list_agents mount (mailbox-scoped, nested ok)", () => {
  test("nested-orchestrator mounts list_agents", async () => {
    const cwd = await tmpCwd();
    let listAgentsMounts = 0;

    await runWithFailingInference((baseURL) =>
      withMockedModuleDuring(
        import.meta.resolve("./agent-fleet.js"),
        (real: typeof import("./agent-fleet.js")) => ({
          ...real,
          createListAgentsTool: (deps: never) => {
            listAgentsMounts++;
            return real.createListAgentsTool(deps);
          },
        }),
        async () => {
          const { runSubAgent: run } = await import("./run.js");
          await run({
            ...baseParams(cwd, join(cwd, ".ctx"), baseURL),
            id: "greybeard-session",
            orchestrator: true,
            orchestratorTier: "nested-orchestrator",
            nestedDispatch: {
              permissionGate: testPermissionGate,
              getWorkdirBase: () => join(cwd, ".ctx"),
              provider: { providerName: "test", baseURL, model: "test-model" },
            },
          }).catch(() => {
            // Inference/agent construction may fail; mount decisions run first.
          });
        },
      ),
    );

    expect(listAgentsMounts).toBe(1);
  }, 15_000);
});
