import { describe, expect, test } from "bun:test";

import { createTaskTool } from "./task-tool.js";
import { createFleetRecords } from "./agent-fleet.js";
import { createSubAgentSessionStore } from "./session-store.js";
import { createPermissionGate } from "../permission/gate.js";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

describe("task via spawn_agent + wait_agents", () => {
  test("a director task with a session store returns the worker report", async () => {
    const sessions = createSubAgentSessionStore();
    const fleetRecords = createFleetRecords();
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/tmp",
      getWorkdirBase: () => "/tmp/workdir",
      provider,
      sessions,
      fleetRecords,
      run: async () => ({
        report: "## Summary\nshipped\n## Findings\nok\n## Blockers\n\n## Paths\n",
      }),
    });
    if (tool.kind !== "full") throw new Error("expected full tool");
    const result = await tool.handler(
      {
        id: "t1",
        name: "task",
        arguments: { description: "ship", prompt: "do it", intent: "explore" },
      },
      new AbortController().signal,
    );
    const content = typeof result.content === "string" ? result.content : "";
    expect(content).toContain('Sub-agent "ship" reported');
    expect(content).toContain("shipped");
  });
});
