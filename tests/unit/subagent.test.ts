import { test, expect } from "bun:test";
import {
  createTaskTool,
  taskToolDefinition,
  type RunSubAgentParams,
  type SubAgentProvider,
} from "../../src/subagent.js";
import { buildSubAgentSystemPrompt } from "../../src/prompts.js";

const provider: SubAgentProvider = {
  providerName: "test",
  baseURL: "https://example.test/v1",
  apiKey: "sk-test",
  model: "test-model",
};

function callHandler(
  tool: ReturnType<typeof createTaskTool>,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

test("task tool definition requires description and prompt", () => {
  expect(taskToolDefinition.name).toBe("task");
  expect(taskToolDefinition.inputSchema.required).toEqual(["description", "prompt"]);
});

test("handler rejects empty description or prompt", async () => {
  const tool = createTaskTool({ cwd: "/repo", getWorkdirBase: () => "/repo/.ctx", provider });
  expect(await callHandler(tool, { description: "", prompt: "do it" })).toContain("Error:");
  expect(await callHandler(tool, { description: "label", prompt: "  " })).toContain("Error:");
});

test("handler forwards trimmed args to the runner and wraps the result", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    maxTurns: 7,
    run: async (params) => {
      received = params;
      return "found three callers in foo.ts";
    },
  });

  const result = await callHandler(tool, {
    description: "  map callers  ",
    prompt: "  find every caller of X  ",
  });

  expect(received?.description).toBe("map callers");
  expect(received?.prompt).toBe("find every caller of X");
  expect(received?.cwd).toBe("/repo");
  expect(received?.maxTurns).toBe(7);
  expect(result).toContain("map callers");
  expect(result).toContain("found three callers in foo.ts");
});

test("handler reports runner failures without throwing", async () => {
  const tool = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => {
      throw new Error("provider exploded");
    },
  });

  const result = await callHandler(tool, { description: "boom", prompt: "trigger failure" });
  expect(result).toContain("Error:");
  expect(result).toContain("provider exploded");
});

test("sub-agent prompt is autonomous and does not advertise the task tool", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain("sub-agent");
  expect(prompt).toContain("without asking for approval");
  // A sub-agent must never be told it can delegate further (no recursion).
  expect(prompt).not.toContain("task,");
});

test("handler injects context block before task when provided", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      received = params;
      return "task completed";
    },
  });

  const result = await callHandler(tool, {
    description: "refactor utils",
    context: "The codebase uses functional programming with no classes.",
    prompt: "Extract duplicated validation logic into a shared function.",
  });

  expect(received?.context).toBe("The codebase uses functional programming with no classes.");
  expect(received?.prompt).toBe("Extract duplicated validation logic into a shared function.");
  expect(result).toContain("task completed");
});

test("handler sends prompt without context block when context is empty or omitted", async () => {
  let receivedNoContext: RunSubAgentParams | undefined;
  let receivedEmptyContext: RunSubAgentParams | undefined;

  const toolNoContext = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      receivedNoContext = params;
      return "done";
    },
  });

  const toolEmptyContext = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      receivedEmptyContext = params;
      return "done";
    },
  });

  await callHandler(toolNoContext, {
    description: "check code",
    prompt: "Review the function signatures.",
  });

  await callHandler(toolEmptyContext, {
    description: "check code",
    context: "  ",
    prompt: "Review the function signatures.",
  });

  expect(receivedNoContext?.context).toBeUndefined();
  expect(receivedEmptyContext?.context).toBeUndefined();
});
