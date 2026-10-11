/**
 * runSubAgent mount echo for requires_tools.
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

import { stringTool } from "@intx/agent";
import { createPermissionGate } from "../permission/gate.js";
import { applyCapabilityFilter, runSubAgent } from "./run.js";
import type { RunSubAgentParams } from "./types.js";
import type { AgentTool } from "@intx/agent";
import type { CapabilityFilter } from "../agent/profiles.js";

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

  test("two stamped tools dropped by the filter are both named in the stale_snapshot error", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file"] },
          requiresTools: ["run_shell", "write_file"],
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
    expect(message).toContain("write_file");
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

  test("requested inherited mcp__linear__ tool survives a built-ins-only allowlist", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file", "run_shell"] },
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
          requiresTools: ["mcp__linear__list_teams"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("stale_snapshot");
  }, 15_000);

  test("unmounted mcp__ requirement still throws stale_snapshot setup_error", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file", "run_shell"] },
          requiresTools: ["mcp__linear__list_teams"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("stale_snapshot");
    expect((error as Error).message).toContain("mcp__linear__list_teams");
  }, 15_000);

  test("requested live mcp__ tool mounts while an inherited sibling stays unmounted", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: { mode: "allow", tools: ["read_file", "run_shell"] },
          inheritMcpTools: () => [
            mcpTool("mcp__linear__list_teams"),
            mcpTool("mcp__linear__create_issue"),
          ],
          requiresTools: ["mcp__linear__list_teams"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    // The stamped requirement mounted (no stale_snapshot); the sibling's
    // absence is pinned by the applyCapabilityFilter unit tests below.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("stale_snapshot");
  }, 15_000);

  test("exclude naming a requested live mcp__ tool throws stale_snapshot setup_error", async () => {
    const cwd = await tmpCwd();
    const error = await withFailingInference(async (baseURL) => {
      try {
        await runSubAgent({
          ...baseParams(cwd, baseURL),
          capabilities: {
            mode: "exclude",
            tools: ["mcp__linear__list_teams"],
          },
          inheritMcpTools: () => [mcpTool("mcp__linear__list_teams")],
          requiresTools: ["mcp__linear__list_teams"],
        });
      } catch (err) {
        return err;
      }
      throw new Error("runSubAgent did not throw");
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("stale_snapshot");
    expect((error as Error).message).toContain("mcp__linear__list_teams");
  }, 15_000);
});

function mcpTool(name: string): AgentTool {
  return stringTool({
    definition: {
      name,
      description: `Inherited ${name}`,
      inputSchema: {},
    },
    handler: async () => name,
  });
}

function builtinTool(name: string): AgentTool {
  return stringTool({
    definition: {
      name,
      description: `Built-in ${name}`,
      inputSchema: {},
    },
    handler: async () => name,
  });
}

function filteredNames(
  tools: AgentTool[],
  capabilities: CapabilityFilter | undefined,
  requiresTools?: readonly string[],
  inheritedMcpTools?: readonly string[],
): string[] {
  return applyCapabilityFilter(
    tools,
    capabilities,
    requiresTools,
    inheritedMcpTools,
  ).map((tool) => tool.definition.name);
}

describe("applyCapabilityFilter on-demand MCP mounting", () => {
  const allowBuild: CapabilityFilter = {
    mode: "allow",
    tools: ["read_file", "run_shell"],
  };
  const tools: AgentTool[] = [
    builtinTool("read_file"),
    builtinTool("run_shell"),
    mcpTool("mcp__linear__list_teams"),
    mcpTool("mcp__linear__create_issue"),
  ];

  test("allowlist mounts only the requested MCP tool, never the inherited set", () => {
    expect(
      filteredNames(tools, allowBuild, ["mcp__linear__list_teams"]),
    ).toEqual(["read_file", "run_shell", "mcp__linear__list_teams"]);
  });

  test("allowlist with no requires_tools mounts no MCP tools", () => {
    expect(filteredNames(tools, allowBuild)).toEqual([
      "read_file",
      "run_shell",
    ]);
  });

  test("allowlist naming an MCP tool mounts it without a requires_tools stamp", () => {
    const allowWithMcp: CapabilityFilter = {
      mode: "allow",
      tools: ["read_file", "mcp__linear__create_issue"],
    };
    expect(filteredNames(tools, allowWithMcp)).toEqual([
      "read_file",
      "mcp__linear__create_issue",
    ]);
  });

  test("exclude keeps a requested live MCP tool unless named explicitly", () => {
    const excludeOther: CapabilityFilter = {
      mode: "exclude",
      tools: ["run_shell"],
    };
    expect(
      filteredNames(tools, excludeOther, ["mcp__linear__list_teams"]),
    ).toEqual(["read_file", "mcp__linear__list_teams"]);
  });

  test("exclude naming a requested live MCP tool withholds it", () => {
    const excludeMcp: CapabilityFilter = {
      mode: "exclude",
      tools: ["mcp__linear__list_teams"],
    };
    expect(
      filteredNames(tools, excludeMcp, ["mcp__linear__list_teams"]),
    ).toEqual(["read_file", "run_shell"]);
  });

  test("exclude with no requires_tools mounts no MCP tools", () => {
    const excludeOther: CapabilityFilter = {
      mode: "exclude",
      tools: ["run_shell"],
    };
    expect(filteredNames(tools, excludeOther)).toEqual(["read_file"]);
  });

  test("full mount mounts only the requested MCP tool", () => {
    expect(
      filteredNames(tools, undefined, ["mcp__linear__list_teams"]),
    ).toEqual(["read_file", "run_shell", "mcp__linear__list_teams"]);
  });

  test("full mount with no requires_tools mounts no MCP tools", () => {
    expect(filteredNames(tools, undefined)).toEqual(["read_file", "run_shell"]);
  });

  test("full mount retains the inherited MCP set without a stamp", () => {
    expect(
      filteredNames(tools, undefined, undefined, [
        "mcp__linear__list_teams",
        "mcp__linear__create_issue",
      ]),
    ).toEqual([
      "read_file",
      "run_shell",
      "mcp__linear__list_teams",
      "mcp__linear__create_issue",
    ]);
  });

  test("full mount drops an mcp__ name outside the inherited set", () => {
    expect(
      filteredNames(tools, undefined, undefined, ["mcp__linear__list_teams"]),
    ).toEqual(["read_file", "run_shell", "mcp__linear__list_teams"]);
  });

  test("full mount with a stamp mounts only the stamped inherited tool", () => {
    expect(
      filteredNames(
        tools,
        undefined,
        ["mcp__linear__list_teams"],
        ["mcp__linear__list_teams", "mcp__linear__create_issue"],
      ),
    ).toEqual(["read_file", "run_shell", "mcp__linear__list_teams"]);
  });
});
