import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@intx/log";
import type { ToolCall } from "@intx/types/runtime";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import * as permissionStore from "../permission/store.js";
import { createPermissionGate } from "../permission/gate.js";
import type { GrantScope } from "../permission/types.js";
import {
  buildSubAgentProvider,
  createApprovalPersist,
  createLiveSubAgentSources,
  createSessionPruningCompactor,
  loadSeededApprovals,
  skillDirsFromEnabledPlugins,
} from "./runtime-assembly.js";
import type { SubAgentSourcesConfig } from "./runtime-assembly.js";
import type { Settings } from "../config/settings.js";
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
    providers: { [name]: { baseURL: "https://api.openai.com/v1", models: ["gpt-5"] } },
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
    expect(Object.keys(live.settings()?.providers ?? {})).toEqual(["codex/work"]);
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
    await permissionStore.saveProjectApproval(cwd, {
      tool: "run_shell",
      pattern: "project npm *",
    });

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
    const project = spyOn(permissionStore, "saveProjectApproval").mockResolvedValue(undefined);
    const global = spyOn(permissionStore, "saveGlobalApproval").mockResolvedValue(undefined);
    const providerModel = spyOn(permissionStore, "saveProviderModelApproval").mockResolvedValue(
      undefined,
    );

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
    const providerModel = spyOn(permissionStore, "saveProviderModelApproval").mockResolvedValue(
      undefined,
    );
    let identity = "openai:gpt-5";
    const persist = createApprovalPersist("/tmp/proj", () => identity);
    const approval = { tool: "run_shell", pattern: "npm *" };

    persist(approval, "provider-model");
    identity = "anthropic:claude-opus";
    persist(approval, "provider-model");

    expect(providerModel).toHaveBeenNthCalledWith(1, "openai:gpt-5", approval);
    expect(providerModel).toHaveBeenNthCalledWith(2, "anthropic:claude-opus", approval);
  });

  const persistedScopes: {
    scope: Exclude<GrantScope, "session">;
    reject: (message: string) => void;
  }[] = [
    {
      scope: "project",
      reject: (message) => {
        spyOn(permissionStore, "saveProjectApproval").mockRejectedValue(new Error(message));
      },
    },
    {
      scope: "global",
      reject: (message) => {
        spyOn(permissionStore, "saveGlobalApproval").mockRejectedValue(new Error(message));
      },
    },
    {
      scope: "provider-model",
      reject: (message) => {
        spyOn(permissionStore, "saveProviderModelApproval").mockRejectedValue(new Error(message));
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
    test(`a rejected ${scope} write is contained, logged, and never becomes an unhandled rejection`, async () => {
      const message = `${scope} disk full`;
      reject(message);

      const persist = createApprovalPersist("/tmp/proj", () => "openai:gpt-5");
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
        providerName: "openai",
        model: "gpt-5",
      });

      expect((await gate.evaluate(shellCall("npm test"))).allowed).toBe(true);
      expect(asked).toBe(1);
      expect(await flushUnhandledRejections()).toBeNull();
      expect((await gate.evaluate(shellCall("npm run build"))).allowed).toBe(true);
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
        manifest: { id: "corbits-skills", name: "skills", kind: "command", defaultEnabled: true },
      },
    ] as unknown as PluginModule[];
    expect(skillDirsFromEnabledPlugins(modules, {})).toEqual(["/skills"]);
  });

  test("excludes a repo defaultEnabled plugin when enabled:false", () => {
    const modules = [
      {
        dir: "/skills",
        origin: "repo",
        manifest: { id: "corbits-skills", name: "skills", kind: "command", defaultEnabled: true },
      },
    ] as unknown as PluginModule[];
    expect(skillDirsFromEnabledPlugins(modules, { "corbits-skills": { enabled: false } })).toEqual(
      [],
    );
  });

  test("ignores defaultEnabled on marketplace/path plugins", () => {
    const modules = [
      {
        dir: "/user",
        origin: "user",
        manifest: { id: "mkt", name: "mkt", kind: "command", defaultEnabled: true },
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
  test("only wires a summarize function in llm mode", async () => {
    const summarize = async () => "summary";
    const pruning = createSessionPruningCompactor({
      compactionMode: "pruning",
      summarize,
    });
    const llm = createSessionPruningCompactor({
      compactionMode: "llm",
      summarize,
    });
    // Both return a Compactor; smoke that apply is present without running a full prune.
    expect(typeof pruning.apply).toBe("function");
    expect(typeof llm.apply).toBe("function");
  });

  test("forwards summaryContext to summarize in llm mode", async () => {
    const ctx = { workflow: { name: "build", stepIndex: 1, total: 3 } };
    let captured: unknown;
    const summarize = async (_turns: unknown, c?: unknown) => {
      captured = c;
      return "summary";
    };
    const llm = createSessionPruningCompactor({
      compactionMode: "llm",
      summarize,
      summaryContext: () => ctx,
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
      compactionMode: "llm",
      summarize,
      onFolded: (info) => folds.push(info),
    });
    const now = Date.now();
    const many = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `t${i}` }],
      timestamp: now,
    }));
    await folding.apply(many as never, { state: {} as never, trigger: "test" });
    expect(folds).toHaveLength(1);
    expect(folds[0]?.turnsBefore).toBe(8);
    expect(folds[0]?.turnsAfter).toBeLessThan(8);

    const silent: { turnsBefore: number; turnsAfter: number }[] = [];
    const noop = createSessionPruningCompactor({
      compactionMode: "llm",
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
});
