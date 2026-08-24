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

import { createPermissionGate } from "../permission/gate.js";
import { FleetAuthorityError } from "./authority.js";
import { runSubAgent } from "./run.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl6941-run-authority-"));
}

function baseParams(cwd: string, workdirBase: string): Omit<RunSubAgentParams, "orchestrator"> {
  return {
    cwd,
    workdirBase,
    permissionGate: testPermissionGate,
    provider: { providerName: "test", baseURL: "http://localhost", model: "test-model" },
    description: "gate probe",
    prompt: "no-op",
  };
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
      throw new Error("expected runSubAgent to reject (missing nestedDispatch)");
    } catch (err) {
      expect(err).not.toBeInstanceOf(FleetAuthorityError);
      expect(String((err as Error).message)).toContain("nestedDispatch");
    }
  });
});
