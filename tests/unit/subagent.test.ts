import { describe, test, expect } from "bun:test";
import {
  appendActivitySummary,
  buildDispatchBrief,
  buildSubAgentPrimarySource,
  createTaskTool,
  formatSubAgentReport,
  parseSubAgentReport,
  runSubAgent,
  subAgentToolName,
  taskToolDefinition,
  type RunSubAgentParams,
  type SubAgentProvider,
} from "../../src/subagent/index.js";
import { createSubAgentSessionStore } from "../../src/subagent/session-store.js";
import { buildSubAgentSystemPrompt } from "../../src/agent/prompts.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import type { ReactorEmittedEvent } from "@intx/inference";

const testPermissionGate = createPermissionGate({
  approvals: [],
  interactive: false,
  skipPermissions: true,
});

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
  // createTaskTool returns a full-handler AgentTool (call + signal → ToolResult).
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  return tool
    .handler({ id: "call-1", name: "task", arguments: args }, new AbortController().signal)
    .then((result) =>
      typeof result.content === "string" ? result.content : JSON.stringify(result.content),
    );
}

test("task tool definition requires description and prompt", () => {
  expect(taskToolDefinition.name).toBe("task");
  expect(taskToolDefinition.inputSchema.required).toEqual(["description", "prompt"]);
});

test("handler rejects empty description or prompt, naming only the empty field", async () => {
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => ({ report: "should not run" }),
  });
  const emptyDesc = await callHandler(tool, { description: "", prompt: "do it" });
  expect(emptyDesc).toContain("Error: task requires a non-empty description");
  expect(emptyDesc).toContain('Received prompt "do it"');
  expect(emptyDesc).not.toContain("non-empty prompt");
  const emptyPrompt = await callHandler(tool, { description: "label", prompt: "  " });
  expect(emptyPrompt).toContain("Error: task requires a non-empty prompt");
  expect(emptyPrompt).toContain('Received description "label" — keep it and add prompt.');
  expect(emptyPrompt).not.toContain("non-empty description");
});

test("handler rejects missing required fields, naming only the missing ones", async () => {
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => ({ report: "should not run" }),
  });
  const missingPrompt = await callHandler(tool, { description: "Add GET /health route" });
  expect(missingPrompt).toContain(
    "Error: task is missing prompt (string): the actionable goal for the worker.",
  );
  expect(missingPrompt).toContain(
    'Received description "Add GET /health route" — keep it and add prompt.',
  );
  expect(missingPrompt).not.toContain("missing description");
  const missingDesc = await callHandler(tool, { prompt: "do it" });
  expect(missingDesc).toContain("Error: task is missing description (string)");
  expect(missingDesc).toContain('Received prompt "do it" — keep it and add description.');
  expect(missingDesc).not.toContain("missing prompt");
  const missingBoth = await callHandler(tool, {});
  expect(missingBoth).toContain("Error: task is missing description (string)");
  expect(missingBoth).toContain("is missing prompt (string)");
  expect(missingBoth).not.toContain("Received");
});

test("generic leaf gets role-default medium even when parent effort is high", async () => {
  // CL-5162: leaves do not inherit primary high — that multiplies the sol+high
  // latency cliff across every spawn. Role default (medium) wins over parent.
  let receivedEffort: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider: { ...provider, reasoningEffort: "high" },
    run: async (params) => {
      receivedEffort = params;
      return { report: "done" };
    },
  });

  await callHandler(tool, { description: "task", prompt: "do it", intent: "explore" });

  expect(receivedEffort?.provider.reasoningEffort).toBe("medium");
});

test("a provider getter is resolved at spawn time, so a live switch reaches subagents", async () => {
  let received: RunSubAgentParams | undefined;
  let current: SubAgentProvider = { ...provider, model: "model-a" };
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider: () => current,
    run: async (params) => {
      received = params;
      return { report: "done" };
    },
  });

  // Simulate a /agent switch after the tool was constructed.
  current = { ...provider, model: "model-b", reasoningEffort: "high" };
  await callHandler(tool, { description: "task", prompt: "do it", intent: "explore" });

  expect(received?.provider.model).toBe("model-b");
  // Live model switch is honored; effort still follows leaf role default.
  expect(received?.provider.reasoningEffort).toBe("medium");
});

test("handler forwards trimmed args to the runner and wraps the result", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      received = params;
      return { report: "found three callers in foo.ts" };
    },
  });

  const result = await callHandler(tool, {
    description: "  map callers  ",
    prompt: "  find every caller of X  ",
    intent: "explore",
  });

  expect(received?.description).toBe("map callers");
  expect(received?.prompt).toBe("find every caller of X");
  expect(received?.cwd).toBe("/repo");
  expect(result).toContain("map callers");
  expect(result).toContain("found three callers in foo.ts");
});

test("handler reports runner failures without throwing", async () => {
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => {
      throw new Error("provider exploded");
    },
  });

  const result = await callHandler(tool, {
    description: "boom",
    prompt: "trigger failure",
    intent: "explore",
  });
  expect(result).toContain("Error:");
  expect(result).toContain("provider exploded");
});

test("sub-agent prompt is autonomous and forbids recursion for workers", () => {
  const prompt = buildSubAgentSystemPrompt();
  expect(prompt).toContain("sub-agent");
  expect(prompt).toContain("permission policy as the parent session");
  expect(prompt).toContain("parent session's permission gate");
  // Workers must not be invited to spawn further agents.
  expect(prompt).toContain("You are a worker");
  expect(prompt).not.toContain("MAY call `task`");
});

test("unknown agent id fails closed instead of silent generic fall-through", async () => {
  let ran = false;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    profiles: [{ id: "greybeard", systemPromptRole: "You are greybeard." }],
    run: async () => {
      ran = true;
      return { report: "should not run" };
    },
  });
  const result = await callHandler(tool, {
    description: "review",
    prompt: "look at it",
    agent: "no-such-agent",
  });
  expect(result).toContain("Error:");
  expect(result).toContain("unknown agent profile");
  expect(result).toContain("greybeard");
  expect(result).toContain("search_agents");
  expect(result).toContain("full system prompt / body");
  expect(ran).toBe(false);
});

test("unknown agent id fails closed when no profiles are loaded", async () => {
  let ran = false;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => {
      ran = true;
      return { report: "should not run" };
    },
  });
  // Non-director ids still require profiles; directors resolve from the closed registry.
  const result = await callHandler(tool, {
    description: "review",
    prompt: "look at it",
    agent: "no-such-agent",
  });
  expect(result).toContain("Error:");
  expect(result).toContain("no agent profiles are loaded");
  expect(ran).toBe(false);
});

test("closed director resolves without profiles loaded", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      received = params;
      return { report: "ok" };
    },
  });
  const result = await callHandler(tool, {
    description: "ship",
    prompt: "implement the fix",
    agent: "build",
  });
  expect(result).toContain("ok");
  expect(received?.systemPromptRole).toBeDefined();
  expect(received?.systemPromptRole).toContain("PRIMARY INTENT");
});

test("intent maps to closed director without profiles", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      received = params;
      return { report: "ok" };
    },
  });
  const result = await callHandler(tool, {
    description: "map code",
    prompt: "find callers of X",
    intent: "explore",
  });
  expect(result).toContain("ok");
  expect(received?.systemPromptRole).toContain("PRIMARY INTENT");
  expect(received?.capabilities?.mode).toBe("allow");
  expect(received?.capabilities?.tools).toContain("read_file");
  expect(received?.capabilities?.tools).toContain("write_file");
  expect(received?.capabilities?.tools).toContain("edit_file");
  expect(received?.capabilities?.tools).toContain("delete_file");
});

test("intent general is refused (no general director)", async () => {
  let ran = false;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => {
      ran = true;
      return { report: "should not run" };
    },
  });
  const result = await callHandler(tool, {
    description: "vague",
    prompt: "do something",
    intent: "general",
  });
  expect(result).toContain("Error:");
  expect(result).toContain("general");
  expect(ran).toBe(false);
});

test("bare task without agent or intent is refused (no catch-all worker)", async () => {
  let ran = false;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => {
      ran = true;
      return { report: "should not run" };
    },
  });
  const result = await callHandler(tool, {
    description: "vague",
    prompt: "do something",
  });
  expect(result).toContain("Error:");
  expect(result).toContain("No director selected");
  expect(ran).toBe(false);
});

test("spawnAllowlist rejects children outside the parent director matrix", async () => {
  let ran = false;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    spawnAllowlist: ["intern", "explore", "critique"],
    run: async () => {
      ran = true;
      return { report: "should not run" };
    },
  });
  const denied = await callHandler(tool, {
    description: "ship code",
    prompt: "implement the feature",
    agent: "build",
  });
  expect(denied).toContain("Error:");
  expect(denied).toContain("allowlist");
  expect(ran).toBe(false);

  const allowed = await callHandler(tool, {
    description: "map",
    prompt: "read the tree",
    agent: "explore",
  });
  expect(allowed).not.toContain("Error:");
  expect(ran).toBe(true);
});

test("task refuses skywalker as a spawned worker", async () => {
  let ran = false;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async () => {
      ran = true;
      return { report: "should not run" };
    },
  });
  const result = await callHandler(tool, {
    description: "orchestrate",
    prompt: "fan out the fleet",
    agent: "skywalker",
  });
  expect(result).toContain("Error:");
  expect(result).toMatch(/primary session identity/i);
  expect(result).not.toContain("allowlist");
  expect(ran).toBe(false);
});

test("greybeard nestedDispatch carries spawn allowlist into nested task", async () => {
  let nestedAllow: readonly string[] | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      nestedAllow = params.nestedDispatch?.spawnAllowlist;
      return { report: "reviewed" };
    },
  });
  await callHandler(tool, {
    description: "arch review",
    prompt: "review approach",
    agent: "greybeard",
  });
  expect(nestedAllow).toEqual(["intern", "explore", "critique"]);
});

test("orchestrator profile installs nestedDispatch so task can be re-dispatched", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    profiles: [
      {
        id: "dispatch",
        orchestrator: true,
        systemPromptRole: "You coordinate specialists.",
      },
    ],
    run: async (params) => {
      received = params;
      return { report: "coordinated" };
    },
  });
  await callHandler(tool, {
    description: "fan out",
    prompt: "dispatch the team",
    agent: "dispatch",
  });
  expect(received?.orchestrator).toBe(true);
  expect(received?.nestedDispatch).toBeDefined();
  expect(received?.systemPromptRole).toContain("coordinate");
});

test("nested dispatch forwards the external sink, not the orchestrator recorder", async () => {
  const store = createSubAgentSessionStore();
  const external: string[] = [];
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    sessions: store,
    onEvent: (event) => external.push(event.type),
    profiles: [{ id: "dispatch", orchestrator: true }],
    run: async (params) => {
      // While the orchestrator session is still running, a grandchild event
      // arrives on the nested sink. It must reach the external sink but not be
      // recorded into the orchestrator's own transcript.
      params.nestedDispatch?.onEvent?.({
        type: "inference.text.delta",
        data: { token: "grandchild" },
      } as ReactorEmittedEvent);
      return { report: "coordinated" };
    },
  });
  await callHandler(tool, { description: "fan out", prompt: "dispatch", agent: "dispatch" });

  const orchestrator = store.list()[0];
  expect(orchestrator).toBeDefined();
  expect(orchestrator!.entries.some((e) => e.kind === "text")).toBe(false);
  expect(external).toContain("inference.text.delta");
});

test("allowOrchestrator false strips orchestrator even when the profile is marked", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    allowOrchestrator: false,
    profiles: [{ id: "dispatch", orchestrator: true }],
    run: async (params) => {
      received = params;
      return { report: "leaf" };
    },
  });
  await callHandler(tool, {
    description: "work",
    prompt: "do the work",
    agent: "dispatch",
  });
  expect(received?.orchestrator).toBeUndefined();
  expect(received?.nestedDispatch).toBeUndefined();
});

test("appendActivitySummary counts tool names", () => {
  expect(appendActivitySummary("done", [])).toBe("done");
  expect(appendActivitySummary("done", ["read_file", "read_file", "grep"])).toBe(
    "done\n\n[tools: read_file×2, grep]",
  );
});

test("subAgentToolName reads tool.start call name", () => {
  const event = {
    type: "tool.start",
    data: { call: { name: "grep" } },
  } as unknown as ReactorEmittedEvent;
  expect(subAgentToolName(event)).toBe("grep");
  expect(
    subAgentToolName({ type: "tool.done", data: {} } as unknown as ReactorEmittedEvent),
  ).toBeNull();
});

test("handler injects context and goals into runner params when provided", async () => {
  let received: RunSubAgentParams | undefined;
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      received = params;
      return { report: "task completed" };
    },
  });

  const result = await callHandler(tool, {
    description: "refactor utils",
    context: "The codebase uses functional programming with no classes.",
    prompt: "Extract duplicated validation logic into a shared function.",
    goals: [" find duplicates ", "", " extract helper "],
    intent: "implement",
  });

  expect(received?.context).toBe("The codebase uses functional programming with no classes.");
  expect(received?.prompt).toBe("Extract duplicated validation logic into a shared function.");
  expect(received?.goals).toEqual(["find duplicates", "extract helper"]);
  expect(result).toContain("task completed");
});

test("handler omits context and goals when empty", async () => {
  let receivedNoContext: RunSubAgentParams | undefined;
  let receivedEmptyContext: RunSubAgentParams | undefined;

  const toolNoContext = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      receivedNoContext = params;
      return { report: "done" };
    },
  });

  const toolEmptyContext = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    run: async (params) => {
      receivedEmptyContext = params;
      return { report: "done" };
    },
  });

  await callHandler(toolNoContext, {
    description: "check code",
    prompt: "Review the function signatures.",
    intent: "explore",
  });

  await callHandler(toolEmptyContext, {
    description: "check code",
    context: "  ",
    prompt: "Review the function signatures.",
    goals: [],
    intent: "explore",
  });

  expect(receivedNoContext?.context).toBeUndefined();
  expect(receivedNoContext?.goals).toBeUndefined();
  expect(receivedEmptyContext?.context).toBeUndefined();
  expect(receivedEmptyContext?.goals).toBeUndefined();
});

test("buildDispatchBrief separates context, goal, and checklist seeds", () => {
  const brief = buildDispatchBrief({
    description: "map callers",
    prompt: "find every caller of X",
    context: "repo uses ES modules",
    goals: ["search", "report"],
  });
  expect(brief).toContain("# Dispatch brief: map callers");
  expect(brief).toContain("## Goal");
  expect(brief).toContain("find every caller of X");
  expect(brief).toContain("## Context");
  expect(brief).toContain("repo uses ES modules");
  expect(brief).toContain("## Suggested checklist");
  expect(brief).toContain("1. search");
  expect(brief).toContain("## Report shape");
});

test("parseSubAgentReport and formatSubAgentReport normalize free-form and structured replies", () => {
  const free = parseSubAgentReport("just some prose");
  expect(free.summary).toBe("just some prose");
  expect(formatSubAgentReport(free)).toContain("## Summary");
  expect(formatSubAgentReport(free)).toContain("just some prose");

  const structured = parseSubAgentReport(
    "## Summary\nDid the thing.\n\n## Findings\nFound three callers.\n\n## Paths\nsrc/a.ts\n",
  );
  expect(structured.summary).toBe("Did the thing.");
  expect(structured.findings).toBe("Found three callers.");
  expect(structured.paths).toBe("src/a.ts");
  const formatted = formatSubAgentReport(structured);
  expect(formatted).toContain("## Findings");
  expect(formatted).not.toContain("## Blockers");
});

test("runSubAgent is wired as the default task runner", () => {
  expect(typeof runSubAgent).toBe("function");
});

describe("buildSubAgentPrimarySource", () => {
  test("builds an openai-compatible source for plain providers", () => {
    const bundle = buildSubAgentPrimarySource(provider);
    expect(bundle.sources[0]?.provider).toBe("openai-compatible");
    expect(bundle.defaultSource).toBe("test");
  });

  test("builds a bifrost source when the provider carries a virtual key", () => {
    const bundle = buildSubAgentPrimarySource({ ...provider, bifrostVirtualKey: true });
    expect(bundle.sources[0]?.provider).toBe("bifrost");
    expect(bundle.sources[0]?.apiKey).toBe("sk-test");
  });

  test("routes an xAI OAuth profile through the grok-responses adapter", () => {
    const catalog = [
      {
        name: "test",
        baseURL: provider.baseURL,
        apiKey: "sk-test",
        models: ["grok-composer-2.5-fast"],
        xaiProfile: "me@example.com",
      },
    ];
    const bundle = buildSubAgentPrimarySource(
      { ...provider, model: "grok-composer-2.5-fast" },
      catalog,
    );
    expect(bundle.sources[0]?.provider).toBe("grok-responses");
  });

  test("routes a Codex OAuth profile through the codex-responses adapter", () => {
    const catalog = [
      {
        name: "test",
        baseURL: provider.baseURL,
        apiKey: "sk-test",
        models: ["gpt-5.1-codex"],
        codexProfile: "me@example.com",
      },
    ];
    const bundle = buildSubAgentPrimarySource({ ...provider, model: "gpt-5.1-codex" }, catalog);
    expect(bundle.sources[0]?.provider).toBe("codex-responses");
  });

  test("routes a catalog bifrost entry through the bifrost adapter", () => {
    const catalog = [
      {
        name: "test",
        baseURL: provider.baseURL,
        apiKey: "sk-bf-test",
        models: ["gpt-5.1"],
        bifrostVirtualKey: true,
      },
    ];
    const bundle = buildSubAgentPrimarySource(provider, catalog);
    expect(bundle.sources[0]?.provider).toBe("bifrost");
  });

  test("falls back to the provider fields when the catalog lacks the provider", () => {
    const bundle = buildSubAgentPrimarySource(provider, []);
    expect(bundle.sources[0]?.provider).toBe("openai-compatible");
    expect(bundle.sources[0]?.baseURL).toContain("example.test");
  });
});

test("a profile-resolved provider carries the bifrost virtual-key marker", async () => {
  let received: RunSubAgentParams | undefined;
  const settings = {
    providers: {
      gateway: {
        name: "gateway",
        baseURL: "https://gateway.test/v1",
        apiKey: "sk-bf-test",
        models: ["gpt-5.1"],
        bifrostVirtualKey: true,
      },
    },
  };
  const tool = createTaskTool({
    permissionGate: testPermissionGate,
    cwd: "/repo",
    getWorkdirBase: () => "/repo/.ctx",
    provider,
    settings: settings as unknown as NonNullable<Parameters<typeof createTaskTool>[0]["settings"]>,
    profiles: [
      {
        id: "p",
        inference: { mode: "pin", order: [{ provider: "gateway", model: "gpt-5.1" }] },
      },
    ],
    run: async (params) => {
      received = params;
      return { report: "ran" };
    },
  });

  await callHandler(tool, { description: "task", prompt: "do it", agent: "p" });

  expect(received?.provider.providerName).toBe("gateway");
  expect(received?.provider.bifrostVirtualKey).toBe(true);
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
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
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
        return { report: "should-not-be-called" };
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
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
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
        return { report: "ran" };
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
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
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
        return { report: "should-not-be-called" };
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

  test("leaf role default applies when the resolved leg does not pin effort", async () => {
    // CL-5162: a profile that pins provider/model without reasoningEffort gets
    // the leaf role default (medium), not the parent's high — so fleet fanout
    // stays off the sol+high cliff unless the profile explicitly pins effort.
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider: { ...provider, reasoningEffort: "high" },
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
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
        return { report: "ran" };
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "p" });

    expect(received?.provider.providerName).toBe("anthropic");
    expect(received?.provider.model).toBe("claude-sonnet-4");
    expect(received?.provider.reasoningEffort).toBe("medium");
  });

  test("profile inference pin for effort wins over role default and parent", async () => {
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider: { ...provider, reasoningEffort: "high" },
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
      profiles: [
        {
          id: "p",
          systemPromptRole: "You are p.",
          inference: {
            mode: "pin",
            order: [{ provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "low" }],
          },
        },
      ],
      run: async (params) => {
        received = params;
        return { report: "ran" };
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "p" });

    expect(received?.provider.reasoningEffort).toBe("low");
  });

  test("orchestrator profile gets high role default when effort is not pinned", async () => {
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider: { ...provider, reasoningEffort: "low" },
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
      profiles: [
        {
          id: "orch",
          systemPromptRole: "You are orch.",
          orchestrator: true,
          inference: {
            mode: "pin",
            order: [{ provider: "anthropic", model: "claude-sonnet-4" }],
          },
        },
      ],
      run: async (params) => {
        received = params;
        return { report: "ran" };
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "orch" });

    expect(received?.orchestrator).toBe(true);
    expect(received?.provider.reasoningEffort).toBe("high");
  });

  test("orchestrator profile flag flows through to the runner params", async () => {
    // Pins the dispatcher wiring for the orchestrator exception: a profile
    // with `orchestrator: true` causes RunSubAgentParams.orchestrator to be
    // set, which buildSubAgentSystemPrompt then uses to grant the recursion
    // exception in the appendix (covered in src/prompts.test.ts).
    let received: RunSubAgentParams | undefined;
    const tool = createTaskTool({
      permissionGate: testPermissionGate,
      cwd: "/repo",
      getWorkdirBase: () => "/repo/.ctx",
      provider,
      settings: baseSettings as unknown as NonNullable<
        Parameters<typeof createTaskTool>[0]["settings"]
      >,
      profiles: [{ id: "karen", systemPromptRole: "You are karen.", orchestrator: true }],
      run: async (params) => {
        received = params;
        return { report: "ran" };
      },
    });

    await callHandler(tool, { description: "task", prompt: "do it", agent: "karen" });

    expect(received?.orchestrator).toBe(true);
    // Fail-closed (CL-6941): no profile field opts a profile-sourced
    // orchestrator into fleet verbs, so the tier stays unresolved and
    // runSubAgent treats it as "leaf" — denied task/search_agents.
    expect(received?.orchestratorTier).toBeUndefined();
  });
});
