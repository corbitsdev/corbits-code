// Each test here feeds an emission site a name that identifies an employer, a
// service, or a path, then asserts that string appears NOWHERE in the bytes
// that would go to PostHog. Serializing the whole request body (not just the
// property the site meant to set) is the point: a comment claiming a value is
// a safe enum is not evidence, and a leak smuggled in under a different key
// would pass a property-by-property check.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUseSkillTool } from "../../src/agent/use-skill.js";
import type { Settings } from "../../src/config/settings.js";
import { createPermissionGate } from "../../src/permission/gate.js";
import { loadPluginEntry } from "../../src/plugins/loader.js";
import { createSessionPruningCompactor } from "../../src/session/runtime-assembly.js";
import {
  createFleetRecords,
  createSpawnAgentTool,
  createWaitAgentsTool,
} from "../../src/subagent/agent-fleet.js";
import { createSubAgentSessionStore } from "../../src/subagent/session-store.js";
import {
  classifyAgentName,
  classifyErrorClass,
  classifyPermissionKind,
} from "../../src/telemetry/classify.js";

import { createTelemetry, NOOP_TELEMETRY, type Telemetry } from "../../src/telemetry/index.js";
import {
  buildSubagentEndProperties,
  captureSlashCommand,
  createPluginLoadReporter,
} from "../../src/telemetry/product-events.js";
import {
  noteCurrentTurnTraceId,
  noteLastTurnTraceId,
  resetFeedbackStateForTests,
} from "../../src/telemetry/feedback.js";
import { captureAuthFailure, classifyAgentSendFailure } from "../../src/tui/session-chrome.js";

interface BatchBody {
  batch: { event: string; properties: Record<string, unknown> }[];
}

function harness(): {
  telemetry: Telemetry;
  wire: () => Promise<string>;
  events: () => Promise<BatchBody["batch"]>;
} {
  const bodies: BatchBody[] = [];
  const fetchFn = ((_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as BatchBody);
    return Promise.resolve(new Response("1", { status: 200 }));
  }) as unknown as typeof fetch;
  const settings: Settings = { providers: {}, telemetry: { installationId: "install-id" } };
  const telemetry = createTelemetry({ settings, env: {}, fetchFn, apiKey: "test-key" });
  const wire = async (): Promise<string> => {
    await telemetry.flush();
    return JSON.stringify(bodies);
  };
  return {
    telemetry,
    wire,
    events: async () => {
      await telemetry.flush();
      return bodies.flatMap((body) => body.batch);
    },
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetFeedbackStateForTests();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. permission_kind — an MCP tool id embeds the server key from settings
// ---------------------------------------------------------------------------

test('permission_prompt buckets an MCP tool to "mcp" and never ships the server key', async () => {
  const { telemetry, wire, events } = harness();
  const gate = createPermissionGate({
    approvals: [],
    interactive: true,
    skipPermissions: false,
    requestApproval: async () => ({ allow: true }),
    telemetry,
  });

  const verdict = await gate.evaluate({
    id: "call-1",
    name: "mcp__acme-internal__deploy",
    arguments: {},
  });

  expect(verdict.allowed).toBe(true);
  const [event] = await events();
  expect(event?.event).toBe("permission_prompt");
  expect(event?.properties.permission_kind).toBe("mcp");
  expect(event?.properties.decision).toBe("allow");
  expect(await wire()).not.toContain("acme-internal");
});

test('permission_prompt buckets an unrecognised tool id to "custom"', async () => {
  const { telemetry, wire, events } = harness();
  const gate = createPermissionGate({
    approvals: [],
    interactive: true,
    skipPermissions: false,
    requestApproval: async () => ({ allow: false }),
    telemetry,
  });

  await gate.evaluate({ id: "call-1", name: "acmecorp_payroll_export", arguments: {} });

  const [event] = await events();
  expect(event?.properties.permission_kind).toBe("custom");
  expect(event?.properties.decision).toBe("deny");
  expect(await wire()).not.toContain("acmecorp");
});

test("permission_prompt reports built-in tool ids by name", () => {
  expect(classifyPermissionKind("run_shell")).toBe("run_shell");
  expect(classifyPermissionKind("edit_file")).toBe("edit_file");
});

// ---------------------------------------------------------------------------
// 2. skill_name — a project-local skill can be named after the employer
// ---------------------------------------------------------------------------

test("skill_used carries no skill name, so an employer-named skill cannot leak", async () => {
  const { telemetry, wire, events } = harness();
  const cwd = await tempDir("corbits-skill-");
  const skillDir = join(cwd, ".agents", "skills", "acme-internal-deploy");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: acme-internal-deploy\n---\n\nDeploy the internal service.\n",
  );

  const tool = createUseSkillTool(cwd, [], telemetry);
  if (tool.kind !== "string") throw new Error(`expected string tool, got ${tool.kind}`);
  const result = await tool.handler({ name: "acme-internal-deploy" }, new AbortController().signal);

  // Guard against the test passing because resolution failed: the event only
  // fires on a resolved skill, so a silent miss would trivially "not leak".
  expect(result).toContain("Deploy the internal service");
  const [event] = await events();
  expect(event?.event).toBe("skill_used");
  expect(event?.properties.skill_name).toBeUndefined();
  expect(await wire()).not.toContain("acme-internal");
});

// ---------------------------------------------------------------------------
// 3. plugin_id — an author-chosen manifest id on a private local plugin
// ---------------------------------------------------------------------------

test("plugin_loaded carries only the discovery origin, never the manifest id", async () => {
  const { telemetry, wire, events } = harness();
  const root = await tempDir("corbits-plugin-");
  const pluginDir = join(root, "plugin");
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      id: "acmecorp/internal-tools",
      name: "acmecorp internal tools",
      version: "1.0.0",
    }),
  );
  await writeFile(
    join(pluginDir, "commands", "ship.md"),
    "---\ndescription: ship it\n---\n\nShip.\n",
  );

  const mod = await loadPluginEntry(pluginDir, {
    cwd: root,
    origin: "project",
    telemetry,
    pluginLoadReporter: createPluginLoadReporter(),
  });

  expect(mod).not.toBeNull();
  const [event] = await events();
  expect(event?.event).toBe("plugin_loaded");
  expect(event?.properties.origin).toBe("project");
  expect(event?.properties.plugin_id).toBeUndefined();
  expect(await wire()).not.toContain("acmecorp");
});

test("disabled plugin reporting does not consume the enabled dedupe identity", async () => {
  const { telemetry, events } = harness();
  const reporter = createPluginLoadReporter();

  reporter(NOOP_TELEMETRY, "project", "/plugin/acme");
  reporter(telemetry, "project", "/plugin/acme");
  reporter(telemetry, "project", "/plugin/acme");

  expect((await events()).filter((event) => event.event === "plugin_loaded")).toHaveLength(1);
});

test("plugin_loaded emits once per plugin identity in-process", async () => {
  const { telemetry, events } = harness();
  const root = await tempDir("corbits-plugin-dedupe-");
  const pluginDir = join(root, "plugin");
  await mkdir(join(pluginDir, "commands"), { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      id: "acmecorp/internal-tools",
      name: "acmecorp internal tools",
      version: "1.0.0",
    }),
  );
  await writeFile(
    join(pluginDir, "commands", "ship.md"),
    "---\ndescription: ship it\n---\n\nShip.\n",
  );

  const pluginLoadReporter = createPluginLoadReporter();
  const options = { cwd: root, origin: "project" as const, telemetry, pluginLoadReporter };
  const first = await loadPluginEntry(pluginDir, options);
  const second = await loadPluginEntry(pluginDir, options);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();

  const captured = await events();
  expect(captured.filter((e) => e.event === "plugin_loaded")).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// 4. agent_name — agent profiles are user-definable per project
// ---------------------------------------------------------------------------

test('subagent events bucket a project-defined profile id to "custom"', async () => {
  const { telemetry, wire, events } = harness();
  const cwd = await tempDir("corbits-agent-");
  const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });

  const sessions = createSubAgentSessionStore();
  const fleetRecords = createFleetRecords();
  const tool = createSpawnAgentTool({
    cwd,
    getWorkdirBase: () => cwd,
    permissionGate: gate,
    provider: { providerName: "test-provider", baseURL: "http://localhost", model: "test-model" },
    profiles: [
      { id: "acmecorp-release-captain", description: "release", systemPromptRole: "release" },
    ],
    sessions,
    fleetRecords,
    run: async (params) => {
      params.onRunSettled?.({
        turn_count: 2,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 1,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        tool_call_count: 3,
        tool_error_count: 1,
        error_count: 0,
        duration_ms: 10,
        model: "test-model",
        terminal_reason: "deadline",
      });
      return { report: "done", stopReason: "deadline" };
    },
    telemetry,
  });
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const wait = createWaitAgentsTool({ sessions, fleetRecords });
  if (wait.kind !== "full") throw new Error(`expected full tool, got ${wait.kind}`);
  await tool.handler(
    {
      id: "call-1",
      name: "spawn_agent",
      arguments: { description: "Ship", prompt: "Ship it", agent: "acmecorp-release-captain" },
    },
    new AbortController().signal,
  );
  await wait.handler(
    { id: "wait-1", name: "wait_agents", arguments: { mode: "all", timeout_ms: 5000 } },
    new AbortController().signal,
  );

  const captured = await events();
  const names = captured.map((e) => e.event);
  expect(names).toContain("subagent_start");
  expect(names).toContain("subagent_end");
  for (const event of captured) {
    expect(event.properties.agent_name).toBe("custom");
    expect(event.properties.parent_session_id).toBeUndefined();
  }
  const end = captured.find((e) => e.event === "subagent_end");
  expect(end?.properties.model).toBe("test-model");
  expect(end?.properties.turn_count).toBe(2);
  expect(end?.properties.tool_call_count).toBe(3);
  expect(end?.properties.tool_error_count).toBe(1);
  expect(end?.properties.input_tokens).toBe(10);
  expect(end?.properties.output_tokens).toBe(5);
  expect(end?.properties.stop_reason).toBe("deadline");
  // No in-flight parent turn was noted — omit rather than invent.
  expect(end?.properties.parent_trace_id).toBeUndefined();
  expect(await wire()).not.toContain("acmecorp");
});

test("subagent_end parent_trace_id is the in-flight turn at spawn, not the last completed turn", async () => {
  const { telemetry, events } = harness();
  const cwd = await tempDir("corbits-parent-trace-");
  const gate = createPermissionGate({ approvals: [], interactive: false, skipPermissions: true });

  // Completed turn 0 is already "last" — spawn happens during turn 1.
  noteLastTurnTraceId("sess:turn:0");
  noteCurrentTurnTraceId("sess:turn:1");

  const sessions = createSubAgentSessionStore();
  const fleetRecords = createFleetRecords();
  const tool = createSpawnAgentTool({
    cwd,
    getWorkdirBase: () => cwd,
    permissionGate: gate,
    provider: { providerName: "test-provider", baseURL: "http://localhost", model: "test-model" },
    profiles: [
      { id: "acmecorp-release-captain", description: "release", systemPromptRole: "release" },
    ],
    sessions,
    fleetRecords,
    run: async () => ({ report: "done" }),
    telemetry,
  });
  if (tool.kind !== "full") throw new Error(`expected full tool, got ${tool.kind}`);
  const wait = createWaitAgentsTool({ sessions, fleetRecords });
  if (wait.kind !== "full") throw new Error(`expected full tool, got ${wait.kind}`);
  await tool.handler(
    {
      id: "call-1",
      name: "spawn_agent",
      arguments: { description: "Ship", prompt: "Ship it", agent: "acmecorp-release-captain" },
    },
    new AbortController().signal,
  );
  await wait.handler(
    { id: "wait-1", name: "wait_agents", arguments: { mode: "all", timeout_ms: 5000 } },
    new AbortController().signal,
  );

  const end = (await events()).find((e) => e.event === "subagent_end");
  expect(end).toBeDefined();
  expect(end?.properties.parent_trace_id).toBe("sess:turn:1");
  expect(end?.properties.parent_trace_id).not.toBe("sess:turn:0");
});

test("buildSubagentEndProperties shapes rollup fields and omits empty parentTraceId", () => {
  const withRollup = buildSubagentEndProperties({
    agentName: "builder",
    status: "completed",
    durationMs: 42,
    model: "gpt-test",
    stopReason: "deadline",
    parentTraceId: "sess:turn:3",
    rollup: {
      turn_count: 4,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      tool_call_count: 7,
      tool_error_count: 1,
    },
  });
  expect(withRollup).toEqual({
    agent_name: "builder",
    status: "completed",
    duration_ms: 42,
    model: "gpt-test",
    stop_reason: "deadline",
    parent_trace_id: "sess:turn:3",
    turn_count: 4,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 2,
    cache_write_tokens: 1,
    reasoning_tokens: 3,
    tool_call_count: 7,
    tool_error_count: 1,
  });

  const bare = buildSubagentEndProperties({
    agentName: "custom",
    status: "failed",
    durationMs: 1,
    parentTraceId: "",
  });
  expect(bare.parent_trace_id).toBeUndefined();
  expect(bare.turn_count).toBeUndefined();
  // Must not invent a parent from last-completed feedback state.
  noteLastTurnTraceId("sess:turn:99");
  expect(
    buildSubagentEndProperties({
      agentName: "custom",
      status: "completed",
      durationMs: 1,
    }).parent_trace_id,
  ).toBeUndefined();
});

test("first-party director ids are reported by name; unknown profiles stay custom", () => {
  expect(classifyAgentName("worker")).toBe("worker");
  expect(classifyAgentName("builder")).toBe("builder");
  expect(classifyAgentName("skywalker")).toBe("skywalker");
  expect(classifyAgentName("greybeard")).toBe("greybeard");
  expect(classifyAgentName("explorer")).toBe("explorer");
  expect(classifyAgentName("counsel")).toBe("counsel");
  expect(classifyAgentName("critic")).toBe("critic");
  expect(classifyAgentName("intern")).toBe("intern");
  expect(classifyAgentName("tester")).toBe("tester");
  expect(classifyAgentName("testsmith")).toBe("testsmith");
  expect(classifyAgentName("shakespeare")).toBe("shakespeare");
  expect(classifyAgentName("rand")).toBe("rand");
  expect(classifyAgentName("draper")).toBe("draper");
  expect(classifyAgentName("emil")).toBe("emil");
  expect(classifyAgentName("gaasbot")).toBe("gaasbot");
  expect(classifyAgentName("bruckheimer")).toBe("bruckheimer");
  expect(classifyAgentName("neckbeard")).toBe("neckbeard");
  expect(classifyAgentName("acmecorp-release-captain")).toBe("custom");
});

// ---------------------------------------------------------------------------
// 5. command_name — plugins register into the same slash-command registry
// ---------------------------------------------------------------------------

test('slash_command buckets a plugin-registered command to "custom"', async () => {
  const { telemetry, wire, events } = harness();

  // Shared product-event helper — not the TUI runner — so headless and TUI
  // callers hit the same emission path (CL-5744).
  captureSlashCommand(telemetry, "acmecorp-deploy");
  captureSlashCommand(telemetry, "settings");

  const captured = await events();
  expect(captured[0]?.properties.command_name).toBe("custom");
  expect(captured[1]?.properties.command_name).toBe("settings");
  expect(await wire()).not.toContain("acmecorp");
});

// ---------------------------------------------------------------------------
// crash — an application or plugin error subclass is author-chosen text
// ---------------------------------------------------------------------------

test("crash reports language error types by name and buckets everything else", async () => {
  const { telemetry, wire, events } = harness();

  class AcmeCorpVaultError extends Error {}
  telemetry.capture("crash", {
    kind: "uncaughtException",
    error_class: classifyErrorClass(new AcmeCorpVaultError("boom")),
  });
  telemetry.capture("crash", {
    kind: "unhandledRejection",
    error_class: classifyErrorClass(new TypeError("boom")),
  });
  telemetry.capture("crash", {
    kind: "uncaughtException",
    error_class: classifyErrorClass("boom"),
  });

  const captured = await events();
  expect(captured.map((e) => e.properties.error_class)).toEqual([
    "custom",
    "TypeError",
    "non_error",
  ]);
  expect(await wire()).not.toContain("AcmeCorp");
});

// ---------------------------------------------------------------------------
// auth_failure — the provider's rejection message names the profile
// ---------------------------------------------------------------------------

test("auth_failure names the provider and never ships the rejection message", async () => {
  const { telemetry, wire, events } = harness();
  const isCodexAuth = (e: unknown) => e instanceof Error && /codex profile/i.test(e.message);
  const isXaiAuth = (e: unknown) => e instanceof Error && /xai profile/i.test(e.message);

  const codexRejection = new Error('Codex profile "acmecorp-eng" is not authorized.');
  const rejections = [
    codexRejection,
    new Error('xai profile "acmecorp-eng" is not authorized.'),
    new Error("anthropic authentication_error: invalid x-api-key for acmecorp-eng"),
    new Error("connection reset by /Users/someone/acmecorp"),
  ];
  for (const err of rejections) {
    captureAuthFailure(telemetry, classifyAgentSendFailure(err, false, isCodexAuth, isXaiAuth));
  }
  // An aborted send outranks the auth match, so it must emit nothing.
  captureAuthFailure(
    telemetry,
    classifyAgentSendFailure(codexRejection, true, isCodexAuth, isXaiAuth),
  );

  const captured = await events();
  expect(captured.map((e) => e.event)).toEqual(["auth_failure", "auth_failure", "auth_failure"]);
  expect(captured.map((e) => e.properties.auth_provider)).toEqual(["codex", "xai", "anthropic"]);
  const body = await wire();
  expect(body).not.toContain("acmecorp");
  expect(body).not.toContain("error_class");
});

// ---------------------------------------------------------------------------
// compaction — must not fire when the compactor did nothing
// ---------------------------------------------------------------------------

test("compaction fires only when turns were actually folded away", async () => {
  const { telemetry, events } = harness();
  const compactor = createSessionPruningCompactor({
    compactionMode: "pruning",
    summarize: async () => "summary",
    telemetry,
  });

  const shortHistory = [
    { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 },
  ];
  await compactor.apply(shortHistory, {} as never);
  expect(await events()).toEqual([]);

  const longHistory = Array.from({ length: 60 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i}` }],
    timestamp: i,
  }));
  await compactor.apply(longHistory, {} as never);

  const captured = await events();
  expect(captured.length).toBe(1);
  expect(captured[0]?.event).toBe("compaction");
  expect(captured[0]?.properties.mode).toBe("pruning");
  expect(captured[0]?.properties.turns_before).toBe(60);
});

// ---------------------------------------------------------------------------
// The allowlist itself: unknown events and unknown keys never reach the wire
// ---------------------------------------------------------------------------

test("an unknown event name is dropped rather than sent", async () => {
  const { telemetry, wire } = harness();
  telemetry.capture("not_a_real_event" as never, { anything: "acmecorp" });
  expect(await wire()).toBe("[]");
});

test("keys outside an event's allowlist are stripped from the payload", async () => {
  const { telemetry, wire, events } = harness();
  telemetry.capture("permission_prompt", {
    decision: "allow",
    permission_kind: "run_shell",
    command: "rm -rf /Users/someone/acmecorp-secrets",
    subject: "/Users/someone/acmecorp-secrets",
  });

  const [event] = await events();
  expect(event?.properties.command).toBeUndefined();
  expect(await wire()).not.toContain("acmecorp");
});
