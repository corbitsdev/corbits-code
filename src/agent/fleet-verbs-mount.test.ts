/**
 * Primary createAgentToolset mounts the fleet verbs beside task / search_agents /
 * read_agent_trace when subAgent (with the shared TUI sessions store) is wired.
 * Leaves / no-subAgent toolsets stay without them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createSubAgentSessionStore } from "../subagent/session-store.js";

const FLEET_VERBS = [
  "spawn_agent",
  "wait_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "followup_task",
  "send_input",
] as const;

describe("primary fleet verb mount", () => {
  test("createAgentToolset registers the fleet verbs when subAgent + sessions are set", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-fleet-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;
    const sessions = createSubAgentSessionStore();

    const toolset = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
      subAgent: {
        provider: {
          providerName: "test",
          baseURL: "http://127.0.0.1:0",
          model: "test-model",
        },
        getWorkdirBase: () => cwd,
        sessions,
      },
    });
    const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(names).toContain("task");
    expect(names).toContain("read_agent_trace");
    for (const name of FLEET_VERBS) {
      expect(names).toContain(name);
    }
    await toolset.dispose();
  });

  test("createAgentToolset omits fleet verbs when subAgent is not set", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-fleet-mount-"));
    const { createAgentToolset } = await import("./tools.js");
    const permissionGate = {
      check: async () => ({ allowed: true }),
      getSkipPermissions: () => false,
    } as never;

    const toolset = await createAgentToolset({
      cwd,
      permissionGate,
      onOperatorGate: async () => ({ kind: "option", index: 0 }),
    });
    const names = toolset.dynamicRunner.currentDefinitions().map((d) => d.name);
    expect(names).not.toContain("task");
    for (const name of FLEET_VERBS) {
      expect(names).not.toContain(name);
    }
    await toolset.dispose();
  });
});
