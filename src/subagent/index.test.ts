import { describe, expect, test } from "bun:test";

import { createTaskTool, type RunSubAgentParams } from "./index.js";

const provider = {
  providerName: "test-provider",
  baseURL: "http://localhost",
  model: "test-model",
};

function callTask(tool: ReturnType<typeof createTaskTool>, args: Record<string, unknown>): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

describe("createTaskTool", () => {
  test("does not forward a parent turn limit to sub-agents", async () => {
    let captured: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.intercode",
      provider,
      maxTurns: 25,
      run: async (params) => {
        captured = params;
        return "done";
      },
    } as Parameters<typeof createTaskTool>[0] & { maxTurns: number });

    const result = await callTask(tool, { description: "Investigate", prompt: "Do the work" });

    expect(result).toContain("done");
    expect(captured).toBeDefined();
    expect(captured).not.toHaveProperty("maxTurns");
  });
});
