/**
 * runSubAgent mount echo for requires_tools (CL-9476).
 *
 * Dispatch verifies requires_tools pre-spawn, but the filter or mount may
 * shift between dispatch and mount. A stamped tool missing after
 * applyCapabilityFilter is a stale snapshot: a setup_error that never
 * retries (non-continuable). These tests drive runSubAgent (the real mount
 * point) end to end with failing inference — mount decisions run before
 * the send, so the echo fires first.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { createPermissionGate } from "../permission/gate.js";
import { runSubAgent } from "./run.js";
import type { RunSubAgentParams } from "./types.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
  reactorGated: false,
});

async function tmpCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl9476-run-requires-tools-"));
}

function baseParams(cwd: string, baseURL: string): RunSubAgentParams {
  return {
    cwd,
    workdirBase: join(cwd, ".ctx"),
    permissionGate: testPermissionGate,
    provider: { providerName: "test", baseURL, model: "test-model" },
    description: "requires-tools probe",
    prompt: "no-op",
  };
}

// A local server answering 401 fails the inference send as a
// credential failure, which is never retried — the cycle costs one local
// round trip, and assertions stay timing-independent.
async function withFailingInference<T>(
  run: (baseURL: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({ error: { message: "requires-tools probe" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
  });
  try {
    return await run(server.url.origin);
  } finally {
    server.stop(true);
  }
}

describe("runSubAgent requires_tools mount echo", () => {
  test("stamped tool dropped by the filter throws stale_snapshot setup_error", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file"] },
          requiresTools: ["run_shell"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("stale_snapshot");
    expect(message).toContain("run_shell");
    expect(message).toContain("setup_error");
    expect(message).toContain("non-continuable");
    expect(message).toContain("Re-dispatch");
    expect(message).not.toContain('continuable": true');
  }, 15_000);

  test("stamped tool present in the mount passes through to inference", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file"] },
          requiresTools: ["read_file"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("stale_snapshot");
  }, 15_000);

  test("stamped manage_tasks survives the echo under a narrow allowlist", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file"] },
          requiresTools: ["manage_tasks"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("stale_snapshot");
  }, 15_000);

  test("stamped update_plan alias survives the echo under a narrow allowlist", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file"] },
          requiresTools: ["update_plan"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("stale_snapshot");
  }, 15_000);

  test("absent requiresTools leaves the mount path unchanged", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file"] },
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("stale_snapshot");
  }, 15_000);
});
