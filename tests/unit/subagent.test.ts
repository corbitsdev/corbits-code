import { describe, test, expect } from "bun:test";
import {
  createTaskTool,
  runSubAgent,
  taskToolDefinition,
  type RunSubAgentParams,
  type SubAgentProvider,
} from "../../src/subagent/index.js";
import { buildSubAgentSystemPrompt } from "../../src/agent/prompts.js";

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

test("handler forwards the provider's reasoning effort to the runner", async () => {
  let receivedEffort: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider: { ...provider, reasoningEffort: "high" },
    run: async (params) => {
      receivedEffort = params;
      return "done";
    },
  });

  await callHandler(tool, { description: "task", prompt: "do it" });

  expect(receivedEffort?.provider.reasoningEffort).toBe("high");
});

test("a provider getter is resolved at spawn time, so a live switch reaches subagents", async () => {
  let received: RunSubAgentParams | undefined;
  let current: SubAgentProvider = { ...provider, model: "model-a" };
  const tool = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider: () => current,
    run: async (params) => {
      received = params;
      return "done";
    },
  });

  // Simulate a /agent switch after the tool was constructed.
  current = { ...provider, model: "model-b", reasoningEffort: "high" };
  await callHandler(tool, { description: "task", prompt: "do it" });

  expect(received?.provider.model).toBe("model-b");
  expect(received?.provider.reasoningEffort).toBe("high");
});

test("handler forwards trimmed args to the runner and wraps the result", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
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

test("runSubAgent is wired as the default task runner", () => {
  expect(typeof runSubAgent).toBe("function");
});

// Profile-driven dispatch: an agent frontmatter can pin inference
// (provider/model/reasoningEffort) with a mode that says whether to fall back
// to the active session when no leg is viable. These tests pin both branches
// of that decision and the pre-dispatch validateEffort check, so a regression
// in the resolver→dispatcher contract surfaces here rather than as a wrong-
// provider sub-agent run.
describe("createTaskTool profile resolution", () => {
  const baseSettings = {
    providers: {
      anthropic: {
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        models: ["claude-sonnet-4", "claude-haiku-4"],
      },
    },
  } as const;

  test("mode: pin agent with an unconfigured provider surfaces an unavailable error and never runs", async () => {
    let runs = 0;
    const tool = createTaskTool({
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as Parameters<typeof createTaskTool>[0]["settings"],
      profiles: [
        {
          id: "p",
          systemPromptRole: "You are p.",
          inference: {
            mode: "pin",
            order: [{ provider: "openai", model: "gpt-5" }],
          },
        },
      ],
      run: async () => {
        runs += 1;
        return "should-not-be-called";
      },
    });

    const result = await callHandler(tool, {
      description: "task",
      prompt: "do it",
      agent: "p",
    });

    expect(runs).toBe(0);
    expect(result).toContain('Error: agent "p" unavailable');
    expect(result).toContain("openai/gpt-5");
    // Actionable hint pointing the user at the remediation paths.
    expect(result.toLowerCase()).toContain("agentmodelfallback");
  });

  test("mode: prefer agent with an unconfigured provider falls back to the active session provider", async () => {
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as Parameters<typeof createTaskTool>[0]["settings"],
      profiles: [
        {
          id: "p",
          systemPromptRole: "You are p.",
          inference: {
            mode: "prefer",
            order: [{ provider: "openai", model: "gpt-5" }],
          },
        },
      ],
      run: async (params) => {
        received = params;
        return "ran";
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "p" });

    // Falls through to the parent's provider (test/test-model from the
    // module-level `provider` constant).
    expect(received?.provider.providerName).toBe("test");
    expect(received?.provider.model).toBe("test-model");
  });

  test("a pinned inference leg whose model is incompatible with its reasoningEffort fails before run", async () => {
    let runs = 0;
    const tool = createTaskTool({
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as Parameters<typeof createTaskTool>[0]["settings"],
      profiles: [
        {
          id: "p",
          systemPromptRole: "You are p.",
          inference: {
            mode: "pin",
            order: [
              // haiku is unknown to the validator → only low/medium/high are
              // accepted; xhigh is restricted to the gpt-5.1 family / codex.
              { provider: "anthropic", model: "claude-haiku-4", reasoningEffort: "xhigh" },
            ],
          },
        },
      ],
      run: async () => {
        runs += 1;
        return "should-not-be-called";
      },
    });

    const result = await callHandler(tool, {
      description: "task",
      prompt: "do it",
      agent: "p",
    });

    expect(runs).toBe(0);
    expect(result).toContain('Error: agent "p" has incompatible inference');
  });

  test("parent reasoningEffort is inherited when the resolved leg does not declare its own", async () => {
    // Regression guard for the P0 fix: an agent that pins inference without a
    // per-leg reasoningEffort still inherits the parent session's effort, so
    // a /agent effort selection propagates uniformly across pinned and
    // fall-through dispatch paths.
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider: { ...provider, reasoningEffort: "high" },
      settings: baseSettings as unknown as Parameters<typeof createTaskTool>[0]["settings"],
      profiles: [
        {
          id: "p",
          systemPromptRole: "You are p.",
          inference: {
            mode: "pin",
            order: [{ provider: "anthropic", model: "claude-sonnet-4" }],
          },
        },
      ],
      run: async (params) => {
        received = params;
        return "ran";
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "p" });

    expect(received?.provider.providerName).toBe("anthropic");
    expect(received?.provider.model).toBe("claude-sonnet-4");
    expect(received?.provider.reasoningEffort).toBe("high");
  });

  test("orchestrator profile flag flows through to the runner params", async () => {
    // Pins the dispatcher wiring for the orchestrator exception: a profile
    // with `orchestrator: true` causes RunSubAgentParams.orchestrator to be
    // set, which buildSubAgentSystemPrompt then uses to grant the recursion
    // exception in the appendix (covered in src/prompts.test.ts).
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as Parameters<typeof createTaskTool>[0]["settings"],
      profiles: [
        { id: "karen", systemPromptRole: "You are karen.", orchestrator: true },
      ],
      run: async (params) => {
        received = params;
        return "ran";
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "karen" });

    expect(received?.orchestrator).toBe(true);
  });
});
