/**
 * Direct-call authority tests prove the assert functions throw, but not that
 * runSubAgent itself cannot be talked into mounting a fleet verb for a caller
 * whose tier cannot be established. These tests drive runSubAgent (the real
 * mount point) end to end.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { withMockedModuleDuring } from "../../testkit/mock-module.js";
import { FleetAuthorityError } from "./authority.js";
import { runSubAgent } from "./run.js";
import type { RunSubAgentParams } from "./types.js";
import { testPermissionGate } from "./fleet-test-harness.js";
import {
  baseRunParams,
  runWithFailingInference,
  tmpSubAgentCwd,
} from "./run-test-harness.js";

async function tmpCwd(): Promise<string> {
  return tmpSubAgentCwd("cl6941-run-authority-");
}

// Each mount-gate probe awaits a full runSubAgent cycle whose inference send
// fails after the mount decisions have run. An unreachable-host target made
// the failure retryable, so the client burned its full backoff schedule (3x
// with 500ms + 1000ms sleeps) per test — enough to cross bun:test's 5s
// timeout under load. A local 401 fails as credential_failure, never
// retried: one local round trip, no timing-sensitive waiting. The 15s
// timeouts below only absorb machine-load spikes; assertions are
// timing-independent.
function baseParams(
  cwd: string,
  baseURL = "http://localhost",
): RunSubAgentParams {
  return baseRunParams(cwd, {
    provider: { providerName: "test", baseURL, model: "test-model" },
    description: "gate probe",
    prompt: "no-op",
  });
}

function nestedDispatch(
  cwd: string,
  baseURL: string,
  withProfiles = false,
): NonNullable<RunSubAgentParams["nestedDispatch"]> {
  return {
    permissionGate: testPermissionGate,
    getWorkdirBase: () => join(cwd, ".ctx"),
    provider: { providerName: "test", baseURL, model: "test-model" },
    ...(withProfiles
      ? { profiles: [{ id: "coder", systemPromptRole: "You are coder." }] }
      : {}),
  };
}

/** Drive runSubAgent under the failing provider with one module mock
 * installed; mount decisions run before the send fails. */
async function probeMount<T extends object>(
  cwd: string,
  modulePath: string,
  impl: (real: T) => object,
  extra: (baseURL: string) => Partial<RunSubAgentParams>,
): Promise<void> {
  await runWithFailingInference((baseURL) =>
    withMockedModuleDuring(modulePath, impl, async () => {
      // Re-import so the mock is visible to runSubAgent's binding.
      const { runSubAgent: run } = await import("./run.js");
      await run({ ...baseParams(cwd, baseURL), ...extra(baseURL) }).catch(
        () => {
          // Inference/agent construction may fail; mount decisions run first.
        },
      );
    }),
  );
}

async function probeSearchAgentsMount(
  cwd: string,
  id: string,
  tier: NonNullable<RunSubAgentParams["orchestratorTier"]>,
): Promise<number> {
  let searchAgentsMounts = 0;
  await probeMount(
    cwd,
    import.meta.resolve("../agent/agent-search.js"),
    (real: typeof import("../agent/agent-search.js")) => ({
      ...real,
      createSearchAgentsTool: (getProfiles: () => never) => {
        searchAgentsMounts++;
        return real.createSearchAgentsTool(getProfiles);
      },
    }),
    (baseURL) => ({
      id,
      orchestrator: true,
      orchestratorTier: tier,
      nestedDispatch: nestedDispatch(cwd, baseURL, true),
    }),
  );
  return searchAgentsMounts;
}

describe("runSubAgent fleet-verb mount gate (CL-6941, fails closed)", () => {
  test("orchestrator=true with no resolvable tier (non-closed-director profile shape) is denied", async () => {
    const cwd = await tmpCwd();
    await expect(
      runSubAgent({
        ...baseParams(cwd),
        orchestrator: true,
        // No directorId, no orchestratorTier — the shape a project/plugin
        // AgentProfile with orchestrator: true produces. nestedDispatch is
        // omitted so the tier gate rejects before the later check runs.
      }),
    ).rejects.toBeInstanceOf(FleetAuthorityError);
  });

  test("orchestrator=true with an explicit leaf tier is denied", async () => {
    const cwd = await tmpCwd();
    await expect(
      runSubAgent({
        ...baseParams(cwd),
        orchestrator: true,
        orchestratorTier: "leaf",
      }),
    ).rejects.toBeInstanceOf(FleetAuthorityError);
  });

  test("orchestrator=true with a resolved non-leaf tier passes the gate (fails later, not on authority)", async () => {
    const cwd = await tmpCwd();
    try {
      await runSubAgent({
        ...baseParams(cwd),
        orchestrator: true,
        orchestratorTier: "nested-orchestrator",
        // Still omit nestedDispatch: a tier that passes the gate must reach
        // the next check (nestedDispatch required), not be denied here.
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
    const searchAgentsMounts = await probeSearchAgentsMount(
      cwd,
      "planner-session",
      "nested-orchestrator",
    );

    expect(searchAgentsMounts).toBe(0);
  }, 15_000);

  test("Tier-1 orchestrator mounts search_agents when profiles exist", async () => {
    const cwd = await tmpCwd();
    const searchAgentsMounts = await probeSearchAgentsMount(
      cwd,
      "dispatch-session",
      "orchestrator",
    );

    expect(searchAgentsMounts).toBe(1);
  }, 15_000);
});

describe("runSubAgent passes parentSessionId into spawn_agent mount", () => {
  test("nested orchestrator fleetDeps.parentSessionId equals params.id", async () => {
    const cwd = await tmpCwd();
    let capturedParentSessionId: string | undefined;
    let spawnMounts = 0;

    await probeMount(
      cwd,
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
      (baseURL) => ({
        id: "greybeard-session",
        orchestrator: true,
        orchestratorTier: "nested-orchestrator",
        nestedDispatch: nestedDispatch(cwd, baseURL, true),
      }),
    );

    expect(spawnMounts).toBe(1);
    expect(capturedParentSessionId).toBe("greybeard-session");
  }, 15_000);
});

describe("runSubAgent list_agents mount (mailbox-scoped, nested ok)", () => {
  test("nested-orchestrator mounts list_agents", async () => {
    const cwd = await tmpCwd();
    let listAgentsMounts = 0;

    await probeMount(
      cwd,
      import.meta.resolve("./agent-fleet.js"),
      (real: typeof import("./agent-fleet.js")) => ({
        ...real,
        createListAgentsTool: (deps: never) => {
          listAgentsMounts++;
          return real.createListAgentsTool(deps);
        },
      }),
      (baseURL) => ({
        id: "greybeard-session",
        orchestrator: true,
        orchestratorTier: "nested-orchestrator",
        nestedDispatch: nestedDispatch(cwd, baseURL),
      }),
    );

    expect(listAgentsMounts).toBe(1);
  }, 15_000);
});
