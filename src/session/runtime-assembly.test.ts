import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@intx/log";
import type { ConversationTurn, ToolCall } from "@intx/types/runtime";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import * as permissionStore from "../permission/store.js";
import { createPermissionGate } from "../permission/gate.js";
import type { GrantScope } from "../permission/types.js";
import {
  APPROVAL_PERSIST_FAILURE_NOTICE,
  buildCompactionContinuationMessage,
  buildMailboxMailMessage,
  buildSubAgentProvider,
  createApprovalPersist,
  createContinuationGate,
  createLiveSubAgentSources,
  createSessionPruningCompactor,
  loadSeededApprovals,
  skillDirsFromEnabledPlugins,
} from "./runtime-assembly.js";
import type { SubAgentSourcesConfig } from "./runtime-assembly.js";
import type { Settings } from "../config/settings.js";
import type { Telemetry } from "../telemetry/index.js";
import { createModelSummarizer } from "./summarizer.js";
import {
  createCompactionArchive,
  wrapCompactorWithCompletenessGate,
} from "./compaction-archive.js";
import {
  COMPACTION_ABORTED_REASON,
  createCompactionLifecycle,
} from "./compaction-lifecycle.js";
import { generateSessionId, initSessionDir, sessionDir } from "./index.js";
import type { PluginModule } from "../plugins/loader.js";

describe("buildSubAgentProvider", () => {
  test("seeds provider fields and omits undefined optionals", () => {
    expect(
      buildSubAgentProvider({
        providerName: "openai",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-5",
        providers: [{ name: "openai" }],
      }),
    ).toEqual({
      providerName: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5",
    });
  });

  test("includes apiKey, reasoningEffort, and bifrostVirtualKey when set", () => {
    expect(
      buildSubAgentProvider({
        providerName: "bifrost",
        baseURL: "https://example.invalid/v1",
        apiKey: "sk-test",
        model: "gpt-5",
        reasoningEffort: "high",
        providers: [{ name: "bifrost", bifrostVirtualKey: true }],
      }),
    ).toEqual({
      providerName: "bifrost",
      baseURL: "https://example.invalid/v1",
      apiKey: "sk-test",
      model: "gpt-5",
      reasoningEffort: "high",
      bifrostVirtualKey: true,
    });
  });

  test("omits explicitReasoningEffort when not operator-chosen", () => {
    expect(
      buildSubAgentProvider({
        providerName: "openai",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-5",
        reasoningEffort: "medium",
        providers: [{ name: "openai" }],
      }),
    ).toEqual({
      providerName: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5",
      reasoningEffort: "medium",
    });
  });

  test("threads explicitReasoningEffort when operator-chosen", () => {
    expect(
      buildSubAgentProvider({
        providerName: "openai",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-5",
        reasoningEffort: "none",
        explicitReasoningEffort: true,
        providers: [{ name: "openai" }],
      }),
    ).toEqual({
      providerName: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5",
      reasoningEffort: "none",
      explicitReasoningEffort: true,
    });
  });
});

describe("createLiveSubAgentSources", () => {
  // One live-config owner for every fact a spawn reads. These were three
  // separately-seeded snapshots that each switch path had to remember to
  // refresh; a mid-session model switch refreshed none of them, so workers
  // kept running against the provider the operator had switched away from.
  const entry = (name: string): SubAgentSourcesConfig["providers"][number] => ({
    name,
    baseURL: "https://api.openai.com/v1",
    models: ["gpt-5"],
  });
  const providerSettings = (name: string): Settings => ({
    providers: {
      [name]: { baseURL: "https://api.openai.com/v1", models: ["gpt-5"] },
    },
  });
  const initial = (): SubAgentSourcesConfig => ({
    providerName: "openai",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5",
    providers: [entry("openai"), entry("anthropic")],
    settings: providerSettings("openai"),
  });

  test("a spawn after a mid-session model switch sees the new provider", () => {
    let config = initial();
    const live = createLiveSubAgentSources(() => config);

    expect(live.provider().providerName).toBe("openai");

    // Mirrors the switch handler's `config = { ...config, providerName, model }`.
    config = { ...config, providerName: "anthropic", model: "claude-opus" };

    expect(live.provider().providerName).toBe("anthropic");
    expect(live.provider().model).toBe("claude-opus");
  });

  test("a spawn after a mid-session connect sees the new catalog and settings", () => {
    let config = initial();
    const live = createLiveSubAgentSources(() => config);

    expect(live.catalog().map((p) => p.name)).toEqual(["openai", "anthropic"]);

    config = {
      ...config,
      providers: [entry("openai"), entry("codex/work")],
      settings: providerSettings("codex/work"),
    };

    expect(live.catalog().map((p) => p.name)).toEqual(["openai", "codex/work"]);
    expect(Object.keys(live.settings()?.providers ?? {})).toEqual([
      "codex/work",
    ]);
  });

  test("settings written mid-session are visible when the session started without any", () => {
    // The old wiring attached a settings getter only when settings existed at
    // startup, so settings written later in the session stayed invisible.
    const { settings: _seeded, ...withoutSettings } = initial();
    let config: SubAgentSourcesConfig = withoutSettings;
    const live = createLiveSubAgentSources(() => config);

    expect(live.settings()).toBeUndefined();

    config = { ...config, settings: providerSettings("openai") };

    expect(live.settings()).toBeDefined();
  });
});

describe("loadSeededApprovals merge order", () => {
  let cwd = "";
  let home = "";
  let sessionId = "";

  afterEach(async () => {
    if (cwd !== "") await rm(cwd, { recursive: true, force: true });
    if (home !== "") await rm(home, { recursive: true, force: true });
    cwd = "";
    home = "";
    sessionId = "";
  });

  test("orders session, then project, before empty global/provider-model layers", async () => {
    cwd = await mkdtemp(join(tmpdir(), "runtime-assembly-"));
    home = await mkdtemp(join(tmpdir(), "runtime-assembly-home-"));
    sessionId = generateSessionId();
    await initSessionDir(cwd, sessionId, home);

    await mkdir(sessionDir(cwd, sessionId, home), { recursive: true });
    await writeFile(
      join(sessionDir(cwd, sessionId, home), "permissions.json"),
      JSON.stringify({
        approvals: [{ tool: "run_shell", pattern: "session npm *" }],
      }),
    );
    await permissionStore.saveProjectApproval(
      cwd,
      {
        tool: "run_shell",
        pattern: "project npm *",
      },
      home,
    );

    const seeded = await loadSeededApprovals(cwd, sessionId, home);

    // Session must lead so gate first-match prefers the tighter session grant.
    // Global / provider-model layers may contain real-home entries; assert prefix only.
    expect(seeded[0]).toEqual({ tool: "run_shell", pattern: "session npm *" });
    expect(seeded[1]).toEqual({ tool: "run_shell", pattern: "project npm *" });
  });
});

describe("createApprovalPersist", () => {
  const persistLogger = getLogger([LOG_NAMESPACE_ROOT, "session", "approvals"]);

  beforeEach(() => {
    spyOn(persistLogger, "warn");
  });

  afterEach(() => {
    mock.restore();
  });

  test("routes project, global, and provider-model scopes to the matching store", () => {
    const project = spyOn(
      permissionStore,
      "saveProjectApproval",
    ).mockResolvedValue(undefined);
    const global = spyOn(
      permissionStore,
      "saveGlobalApproval",
    ).mockResolvedValue(undefined);
    const providerModel = spyOn(
      permissionStore,
      "saveProviderModelApproval",
    ).mockResolvedValue(undefined);

    const persist = createApprovalPersist("/tmp/proj", () => "openai:gpt-5");
    const approval = { tool: "run_shell", pattern: "npm *" };

    persist(approval, "project");
    persist(approval, "global");
    persist(approval, "provider-model");
    // Session scope is gate-memory only — persist must no-op.
    persist(approval, "session");

    expect(project).toHaveBeenCalledWith("/tmp/proj", approval);
    expect(global).toHaveBeenCalledWith(approval);
    expect(providerModel).toHaveBeenCalledWith("openai:gpt-5", approval);
    expect(project).toHaveBeenCalledTimes(1);
    expect(global).toHaveBeenCalledTimes(1);
    expect(providerModel).toHaveBeenCalledTimes(1);
  });

  test("a live identity change stores the next provider-model grant under the new key", () => {
    const providerModel = spyOn(
      permissionStore,
      "saveProviderModelApproval",
    ).mockResolvedValue(undefined);
    let identity = "openai:gpt-5";
    const persist = createApprovalPersist("/tmp/proj", () => identity);
    const approval = { tool: "run_shell", pattern: "npm *" };

    persist(approval, "provider-model");
    identity = "anthropic:claude-opus";
    persist(approval, "provider-model");

    expect(providerModel).toHaveBeenNthCalledWith(1, "openai:gpt-5", approval);
    expect(providerModel).toHaveBeenNthCalledWith(
      2,
      "anthropic:claude-opus",
      approval,
    );
  });

  const persistedScopes: {
    scope: Exclude<GrantScope, "session">;
    reject: (message: string) => void;
  }[] = [
    {
      scope: "project",
      reject: (message) => {
        spyOn(permissionStore, "saveProjectApproval").mockRejectedValue(
          new Error(message),
        );
      },
    },
    {
      scope: "global",
      reject: (message) => {
        spyOn(permissionStore, "saveGlobalApproval").mockRejectedValue(
          new Error(message),
        );
      },
    },
    {
      scope: "provider-model",
      reject: (message) => {
        spyOn(permissionStore, "saveProviderModelApproval").mockRejectedValue(
          new Error(message),
        );
      },
    },
  ];

  const shellCall = (command: string): ToolCall => ({
    id: "c",
    name: "run_shell",
    arguments: { command },
  });

  async function flushUnhandledRejections(): Promise<unknown> {
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown): void => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    return unhandled;
  }

  for (const { scope, reject } of persistedScopes) {
    test(`a rejected ${scope} write is contained, logged, noticed, and never becomes an unhandled rejection`, async () => {
      const message = `${scope} disk full`;
      reject(message);
      const notices: string[] = [];

      const persist = createApprovalPersist(
        "/tmp/proj",
        () => "openai:gpt-5",
        (text) => {
          notices.push(text);
        },
      );
      persist({ tool: "run_shell", pattern: "npm *" }, scope);

      expect(await flushUnhandledRejections()).toBeNull();
      expect(persistLogger.warn).toHaveBeenCalledTimes(1);
      expect(persistLogger.warn).toHaveBeenCalledWith(
        "Failed to persist {scope} approval: {error}",
        {
          scope,
          error: message,
        },
      );
      expect(notices).toEqual([APPROVAL_PERSIST_FAILURE_NOTICE]);
    });

    test(`a throwing ${scope} persist notice is contained and never becomes an unhandled rejection`, async () => {
      reject(`${scope} EIO`);

      const persist = createApprovalPersist(
        "/tmp/proj",
        () => "openai:gpt-5",
        () => {
          throw new Error("notice exploded");
        },
      );
      persist({ tool: "run_shell", pattern: "npm *" }, scope);

      expect(await flushUnhandledRejections()).toBeNull();
    });

    test(`an approved call still completes and the in-memory ${scope} grant still applies when persist rejects`, async () => {
      reject(`${scope} EACCES`);
      const persist = createApprovalPersist("/tmp/proj", () => "openai:gpt-5");
      let asked = 0;
      const gate = createPermissionGate({
        approvals: [],
        requestApproval: async () => {
          asked++;
          return {
            allow: true,
            persist: { id: scope, label: "", pattern: "npm *", grant: scope },
          };
        },
        persist,
        interactive: true,
        skipPermissions: false,
        reactorGated: false,
        providerName: "openai",
        model: "gpt-5",
      });

      expect((await gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
      expect(asked).toBe(1);
      expect(await flushUnhandledRejections()).toBeNull();
      expect((await gate.evaluate(shellCall("npm run build"))).allowed).toBe(
        true,
      );
      expect(asked).toBe(1);
    });
  }
});

describe("skillDirsFromEnabledPlugins", () => {
  test("keeps only enabled plugins that have a dir and manifest id", () => {
    const modules = [
      { dir: "/a", manifest: { id: "on" }, metadataOnly: false },
      { dir: "/b", manifest: { id: "off" }, metadataOnly: false },
      { dir: "/c", metadataOnly: false },
      { manifest: { id: "no-dir" }, metadataOnly: false },
      { dir: "/d", manifest: { id: "missing-config" }, metadataOnly: false },
    ] as unknown as PluginModule[];

    expect(
      skillDirsFromEnabledPlugins(modules, {
        on: { enabled: true },
        off: { enabled: false },
      }),
    ).toEqual(["/a"]);
  });

  test("includes a repo defaultEnabled plugin with no settings entry", () => {
    const modules = [
      {
        dir: "/skills",
        origin: "repo",
        manifest: {
          id: "corbits-skills",
          name: "skills",
          kind: "command",
          defaultEnabled: true,
        },
      },
    ] as unknown as PluginModule[];
    expect(skillDirsFromEnabledPlugins(modules, {})).toEqual(["/skills"]);
  });

  test("excludes a repo defaultEnabled plugin when enabled:false", () => {
    const modules = [
      {
        dir: "/skills",
        origin: "repo",
        manifest: {
          id: "corbits-skills",
          name: "skills",
          kind: "command",
          defaultEnabled: true,
        },
      },
    ] as unknown as PluginModule[];
    expect(
      skillDirsFromEnabledPlugins(modules, {
        "corbits-skills": { enabled: false },
      }),
    ).toEqual([]);
  });

  test("ignores defaultEnabled on marketplace/path plugins", () => {
    const modules = [
      {
        dir: "/user",
        origin: "user",
        manifest: {
          id: "mkt",
          name: "mkt",
          kind: "command",
          defaultEnabled: true,
        },
      },
      {
        dir: "/path",
        origin: "path",
        manifest: { id: "p", name: "p", kind: "command", defaultEnabled: true },
      },
    ] as unknown as PluginModule[];
    expect(skillDirsFromEnabledPlugins(modules, {})).toEqual([]);
  });
});

describe("createSessionPruningCompactor", () => {
  test("forwards summaryContext to summarize in llm mode", async () => {
    const ctx = { workflow: { name: "build", stepIndex: 1, total: 3 } };
    let captured: unknown;
    const summarize = async (_turns: unknown, c?: unknown) => {
      captured = c;
      return "summary";
    };
    const llm = createSessionPruningCompactor({
      summarize,
      summaryContext: () => ctx,
      // Pin a one-token tail budget so this tiny fixture still folds.
      compactionShape: { tailBudgetTokens: 1 },
    });
    const now = Date.now();
    const turns = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    await llm.apply(turns as never, { state: {} as never, trigger: "test" });
    expect(captured).toBe(ctx);
  });

  test("onFolded fires only when turns were actually folded", async () => {
    const folds: { turnsBefore: number; turnsAfter: number }[] = [];
    const summarize = async () => "summary";
    const folding = createSessionPruningCompactor({
      summarize,
      onFolded: (info) => folds.push(info),
      // Pin a one-token tail budget so this tiny fixture still folds.
      compactionShape: { tailBudgetTokens: 1 },
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    const folded = await folding.apply(many as never, {
      state: {} as never,
      trigger: "test",
    });
    expect(folds).toHaveLength(1);
    expect(folds[0]?.turnsBefore).toBe(8);
    expect(
      folded.output[0]?.content.some(
        (block) =>
          block.type === "text" &&
          block.text.startsWith("[Compacted prior context]"),
      ),
    ).toBe(true);

    const silent: { turnsBefore: number; turnsAfter: number }[] = [];
    const noop = createSessionPruningCompactor({
      summarize,
      onFolded: (info) => silent.push(info),
    });
    const few = Array.from({ length: 3 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    await noop.apply(few as never, { state: {} as never, trigger: "test" });
    expect(silent).toEqual([]);
  });

  test("a discarded fold emits no telemetry and no onFolded", async () => {
    const captured: { event: string }[] = [];
    const folds: { turnsBefore: number; turnsAfter: number }[] = [];
    const telemetry: Telemetry = {
      enabled: true,
      installationId: "test",
      capture: (event) => {
        captured.push({ event });
      },
      captureIntentional: () => false,
      flush: async () => undefined,
      discard: () => undefined,
    };
    // Bound to the lifecycle signal in production: true once the outer abort
    // race has discarded (or will discard) this run's output.
    let aborted = false;
    const compactor = createSessionPruningCompactor({
      summarize: async () => "summary",
      telemetry,
      onFolded: (info) => folds.push(info),
      isAborted: () => aborted,
      // Pin a one-token tail budget so this tiny fixture still folds.
      compactionShape: { tailBudgetTokens: 1 },
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    // A live fold still reports…
    const folded = await compactor.apply(many as never, {
      state: {} as never,
      trigger: "test",
    });
    expect(folds).toHaveLength(1);
    expect(captured.map((entry) => entry.event)).toEqual(["compaction"]);
    // …but a fold the lifecycle discarded reports nothing, while the output
    // itself still passes through untouched (fold semantics unchanged).
    aborted = true;
    const discarded = await compactor.apply(many as never, {
      state: {} as never,
      trigger: "test",
    });
    expect(discarded.output).toEqual(folded.output);
    expect(folds).toHaveLength(1);
    expect(captured.map((entry) => entry.event)).toEqual(["compaction"]);
  });
});

describe("createSessionPruningCompactor stub fallback", () => {
  test("a summarizer stub fallback folds without success telemetry and still runs onFolded", async () => {
    const captured: { event: string }[] = [];
    const folds: { turnsBefore: number; turnsAfter: number; stub: boolean }[] =
      [];
    const telemetry: Telemetry = {
      enabled: true,
      installationId: "test",
      capture: (event) => {
        captured.push({ event });
      },
      captureIntentional: () => false,
      flush: async () => undefined,
      discard: () => undefined,
    };
    const notices: string[] = [];
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "openai",
          model: "test-model",
          baseURL: "http://localhost:1",
          credentialId: "test",
        }) as never,
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    const compactor = createSessionPruningCompactor({
      summarize,
      telemetry,
      onFolded: (info) => folds.push(info),
      onFailure: (text) => notices.push(text),
      compactionShape: { tailBudgetTokens: 1 },
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    const result = await compactor.apply(many as never, {
      state: {} as never,
      trigger: "test",
    });
    expect(result.record.decisions.summarizeFailed).toBe(1);
    expect(result.record.reason).toContain("statistics-only stub");
    expect(folds).toEqual([
      { turnsBefore: 8, turnsAfter: result.output.length, stub: true },
    ]);
    expect(captured).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("statistics-only stub");
    expect(notices[0]).toContain("failed");
    expect(notices[0]).toContain("model unreachable");
  });

  test("verify abort after a failed summary keeps prior context and fires no stub notice", async () => {
    const notices: string[] = [];
    const folds: { stub: boolean }[] = [];
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "openai",
          model: "test-model",
          baseURL: "http://localhost:1",
          credentialId: "test",
        }) as never,
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    const now = Date.now();
    const turns = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "Migrate the auth module to opaque tokens",
          },
        ],
        timestamp: now,
      },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool_call" as const,
            id: "c1",
            name: "run_shell",
            arguments: { command: "bun test auth" },
          },
        ],
        timestamp: now,
      },
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            callId: "c1",
            isError: true,
            content: [
              { type: "text" as const, text: "token refresh assertion failed" },
            ],
          },
        ],
        timestamp: now,
      },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Working through the failure" },
        ],
        timestamp: now,
      },
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "Confirm there are no errors remaining in auth",
          },
        ],
        timestamp: now,
      },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Continuing the auth work now" },
        ],
        timestamp: now,
      },
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "There are no errors remaining in the suite",
          },
        ],
        timestamp: now,
      },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "I will keep going from here" },
        ],
        timestamp: now,
      },
    ];
    const result = await createSessionPruningCompactor({
      summarize,
      onFolded: (info) => folds.push(info),
      onFailure: (text) => notices.push(text),
      compactionShape: { tailBudgetTokens: 1 },
    }).apply(turns as never, { state: {} as never, trigger: "test" });
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("verify failed — keeping prior context");
    expect(result.record.decisions.summarizedTurnCount).toBeUndefined();
    expect(folds).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("completeness-gate discard after a stub fold fires no notice or onFolded", async () => {
    const notices: string[] = [];
    const folds: { stub: boolean }[] = [];
    const captured: { event: string }[] = [];
    const telemetry: Telemetry = {
      enabled: true,
      installationId: "test",
      capture: (event) => {
        captured.push({ event });
      },
      captureIntentional: () => false,
      flush: async () => undefined,
      discard: () => undefined,
    };
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "openai",
          model: "test-model",
          baseURL: "http://localhost:1",
          credentialId: "test",
        }) as never,
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "compaction-gate-stub-"));
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-gate-stub",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    const now = Date.now();
    const many: ConversationTurn[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    const result = await createSessionPruningCompactor({
      summarize,
      telemetry,
      onFolded: (info) => folds.push(info),
      onFailure: (text) => notices.push(text),
      compactionShape: { tailBudgetTokens: 1 },
      wrapPruning: (pruning) =>
        wrapCompactorWithCompletenessGate(pruning, archive),
    }).apply(many, { state: {} as never, trigger: "test" });
    expect(result.output).toBe(many);
    expect(result.record.reason).toBe("incomplete-evidence-archive");
    expect(result.record.decisions.summarizedTurnCount).toBeUndefined();
    expect(folds).toEqual([]);
    expect(notices).toEqual([]);
    expect(captured).toEqual([]);
  });

  test("a committed stub fold still notices and prunes", async () => {
    const notices: string[] = [];
    const folds: { turnsBefore: number; turnsAfter: number; stub: boolean }[] =
      [];
    const captured: { event: string }[] = [];
    const telemetry: Telemetry = {
      enabled: true,
      installationId: "test",
      capture: (event) => {
        captured.push({ event });
      },
      captureIntentional: () => false,
      flush: async () => undefined,
      discard: () => undefined,
    };
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "openai",
          model: "test-model",
          baseURL: "http://localhost:1",
          credentialId: "test",
        }) as never,
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "compaction-gate-stub-ok-"));
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-gate-stub-ok",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `t${i}` }],
      timestamp: now,
    }));
    for (const turn of many) {
      const block = turn.content[0];
      if (block?.type !== "text") continue;
      await archive.recordAuthorizedPayload({
        kind: turn.role === "assistant" ? "assistant_text" : "user_message",
        payload: block.text,
      });
    }
    const result = await createSessionPruningCompactor({
      summarize,
      telemetry,
      onFolded: (info) => folds.push(info),
      onFailure: (text) => notices.push(text),
      compactionShape: { tailBudgetTokens: 1 },
      wrapPruning: (pruning) =>
        wrapCompactorWithCompletenessGate(pruning, archive),
    }).apply(many as never, { state: {} as never, trigger: "test" });
    expect(result.record.decisions.summarizeFailed).toBe(1);
    expect(result.record.reason).toContain("statistics-only stub");
    expect(result.output).not.toBe(many);
    expect(folds).toEqual([
      { turnsBefore: 8, turnsAfter: result.output.length, stub: true },
    ]);
    expect(captured).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("statistics-only stub");
    expect(notices[0]).toContain("failed");
    const committedHandoffs = (await archive.listOccurrences()).filter(
      (occurrence) => occurrence.provenance === "compaction-handoff",
    );
    expect(committedHandoffs.length).toBeGreaterThan(0);
  });

  test("TUI abort after a gate-committed stub does not record a phantom handoff", async () => {
    const notices: string[] = [];
    const folds: { stub: boolean }[] = [];
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "openai",
          model: "test-model",
          baseURL: "http://localhost:1",
          credentialId: "test",
        }) as never,
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "compaction-gate-stub-abort-"));
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-gate-stub-abort",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `t${i}` }],
      timestamp: now,
    }));
    for (const turn of many) {
      const block = turn.content[0];
      if (block?.type !== "text") continue;
      await archive.recordAuthorizedPayload({
        kind: turn.role === "assistant" ? "assistant_text" : "user_message",
        payload: block.text,
      });
    }
    const lifecycle = createCompactionLifecycle();
    const isAborted = () => lifecycle.getSignal().aborted;
    let releaseGated: () => void = () => undefined;
    const gatedFinished = new Promise<void>((resolve) => {
      releaseGated = resolve;
    });
    const abortingArchive = {
      ...archive,
      certifyRange: async (ids: readonly string[]) => {
        const certificate = await archive.certifyRange(ids);
        lifecycle.abortCompaction("operator interrupt");
        return certificate;
      },
    };
    const wrapped = lifecycle.wrapCompactor(
      createSessionPruningCompactor({
        summarize,
        onFolded: (info) => folds.push(info),
        onFailure: (text) => notices.push(text),
        isAborted,
        compactionShape: { tailBudgetTokens: 1 },
        wrapPruning: (pruning) => {
          const gated = wrapCompactorWithCompletenessGate(
            pruning,
            abortingArchive,
            { isAborted },
          );
          return {
            name: gated.name,
            version: gated.version,
            apply: async (turns, ctx) => {
              try {
                return await gated.apply(turns, ctx);
              } finally {
                releaseGated();
              }
            },
          };
        },
      }),
    );
    const result = await wrapped.apply(many as never, {
      state: {} as never,
      trigger: "test",
    });
    await gatedFinished;
    expect(result.output).toBe(many);
    expect(result.record.reason).toBe(COMPACTION_ABORTED_REASON);
    expect(folds).toEqual([]);
    expect(notices).toEqual([]);
    const handoffs = (await archive.listOccurrences()).filter(
      (occurrence) => occurrence.provenance === "compaction-handoff",
    );
    expect(handoffs).toEqual([]);
  });

  test("abort then reset during certifyRange does not record a phantom handoff", async () => {
    const notices: string[] = [];
    const folds: { stub: boolean }[] = [];
    const summarize = createModelSummarizer({
      getSource: () =>
        ({
          id: "test",
          provider: "openai",
          model: "test-model",
          baseURL: "http://localhost:1",
          credentialId: "test",
        }) as never,
      complete: async () => {
        throw new Error("model unreachable");
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "compaction-gate-abort-reset-"));
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-gate-abort-reset",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `t${i}` }],
      timestamp: now,
    }));
    for (const turn of many) {
      const block = turn.content[0];
      if (block?.type !== "text") continue;
      await archive.recordAuthorizedPayload({
        kind: turn.role === "assistant" ? "assistant_text" : "user_message",
        payload: block.text,
      });
    }
    const lifecycle = createCompactionLifecycle();
    const getSignal = () => lifecycle.getSignal();
    const isAborted = () => lifecycle.getSignal().aborted;
    let releaseGated: () => void = () => undefined;
    const gatedFinished = new Promise<void>((resolve) => {
      releaseGated = resolve;
    });
    const abortingArchive = {
      ...archive,
      certifyRange: async (ids: readonly string[]) => {
        const certificate = await archive.certifyRange(ids);
        lifecycle.abortCompaction("operator interrupt");
        // onBuilt reset() mints a fresh controller; the in-flight apply
        // must still treat this compact as aborted.
        lifecycle.reset();
        return certificate;
      },
    };
    const wrapped = lifecycle.wrapCompactor(
      createSessionPruningCompactor({
        summarize,
        onFolded: (info) => folds.push(info),
        onFailure: (text) => notices.push(text),
        getSignal,
        isAborted,
        compactionShape: { tailBudgetTokens: 1 },
        wrapPruning: (pruning) => {
          const gated = wrapCompactorWithCompletenessGate(
            pruning,
            abortingArchive,
            { getSignal, isAborted },
          );
          return {
            name: gated.name,
            version: gated.version,
            apply: async (turns, ctx) => {
              try {
                return await gated.apply(turns, ctx);
              } finally {
                releaseGated();
              }
            },
          };
        },
      }),
    );
    const result = await wrapped.apply(many as never, {
      state: {} as never,
      trigger: "test",
    });
    await gatedFinished;
    expect(result.output).toBe(many);
    expect(result.record.reason).toBe(COMPACTION_ABORTED_REASON);
    expect(folds).toEqual([]);
    expect(notices).toEqual([]);
    const handoffs = (await archive.listOccurrences()).filter(
      (occurrence) => occurrence.provenance === "compaction-handoff",
    );
    expect(handoffs).toEqual([]);
  });
});

describe("buildCompactionContinuationMessage", () => {
  test("builds a content-less system inbound that re-enters the reactor", () => {
    const message = buildCompactionContinuationMessage();
    expect(message.content).toBe("");
    expect(message.flags).toEqual([]);
    expect(message.signatureStatus).toBe("missing");
    expect(message.ref).toEqual({ uid: 0, mailbox: "system" });
    expect(message.headers.from).toBe("user@local");
    expect(message.headers.to).toEqual(["agent@local"]);
    expect(message.headers.messageId.startsWith("compact-continue-")).toBe(
      true,
    );
  });
});

describe("createContinuationGate", () => {
  test("delivers each continuation emission once and ignores a replayed duplicate", () => {
    const gate = createContinuationGate();
    expect(gate.shouldDeliver(7)).toBe(true);
    // A replayed duplicate of the answered emission must not re-deliver:
    // each delivery costs a billable inference.
    expect(gate.shouldDeliver(7)).toBe(false);
    // A distinct emission is still answered.
    expect(gate.shouldDeliver(8)).toBe(true);
  });

  test("gates are per-host: a fresh gate answers the same seq", () => {
    const first = createContinuationGate();
    expect(first.shouldDeliver(3)).toBe(true);
    expect(createContinuationGate().shouldDeliver(3)).toBe(true);
  });
});

describe("buildMailboxMailMessage", () => {
  test("builds a system inbound with mailbox mail content", () => {
    const message = buildMailboxMailMessage("mailbox mail — reports");
    expect(message.content).toBe("mailbox mail — reports");
    expect(message.flags).toEqual([]);
    expect(message.signatureStatus).toBe("missing");
    expect(message.ref).toEqual({ uid: 0, mailbox: "system" });
    expect(message.headers.from).toBe("user@local");
    expect(message.headers.to).toEqual(["agent@local"]);
    expect(message.headers.messageId.startsWith("mailbox-mail-")).toBe(true);
  });
});
