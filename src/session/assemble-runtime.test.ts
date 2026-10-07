import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, DirectorRegistry } from "@intx/agent";
import type {
  AuditStore,
  Compactor,
  ContextStore,
  ToolDefinition,
} from "@intx/types/runtime";

import { withMockedModuleDuring } from "../../testkit/mock-module.js";
import type { ChatDirector } from "../agent/director.js";
import { authzParityDefinitions } from "../agent/tool-aliases.js";
import { syncRunStateHandle, type RunStateHandle } from "./active-run.js";
import {
  commitIdlePromotionPrune,
  createAdvertisedToolset,
  loadSessionLocalSettings,
  type ChatAgentWiring,
} from "./assemble-runtime.js";
import { loadState, saveState } from "./state.js";

function def(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
  };
}

function wiring(
  overrides: Partial<Parameters<typeof createAdvertisedToolset>[0]> = {},
) {
  return {
    sessionMode: "orchestrator" as const,
    toolAvailability: { languageServerAvailable: false },
    getProvider: () => ({ providerName: "openai", model: "gpt-5" }),
    ...overrides,
  };
}

describe("createAdvertisedToolset", () => {
  test("drops names outside the built-in prefix", () => {
    const { computeAdvertised } = createAdvertisedToolset(wiring());
    const names = computeAdvertised([
      def("write_file"),
      def("mystery_tool"),
    ]).map((d) => d.name);
    expect(names).not.toContain("mystery_tool");
  });

  test("claude sees write/edit/delete; gpt sees one apply_patch instead", () => {
    const registry = [
      def("write_file"),
      def("edit_file"),
      def("delete_file"),
      def("apply_patch"),
      def("run_shell"),
      def("manage_tasks"),
    ];
    const claude = createAdvertisedToolset(
      wiring({
        getProvider: () => ({
          providerName: "anthropic",
          model: "claude-sonnet-5-5",
        }),
      }),
    ).computeAdvertised(registry);
    expect(claude.map((d) => d.name)).toEqual([
      "write",
      "edit",
      "delete",
      "bash",
      "todowrite",
    ]);

    const gpt = createAdvertisedToolset(
      wiring({
        getProvider: () => ({ providerName: "openai", model: "gpt-5-codex" }),
      }),
    ).computeAdvertised(registry);
    expect(gpt.map((d) => d.name)).toEqual([
      "apply_patch",
      "shell",
      "update_plan",
    ]);
  });

  // Activation opens the call gate but does not reshape the wire set until
  // flushPromotions commits it.
  test("activation alone leaves the wire set untouched until flushPromotions commits it", () => {
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset(wiring());
    const registry = [def("read_file"), def("mystery_tool")];
    const wireBefore = JSON.stringify(computeAdvertised(registry));
    expect(activated.activate(["mystery_tool"])).toBe(true);
    // Byte-identical adapter input across turns differing only in activation:
    // the provider's serialized tools payload cannot drift mid-session.
    expect(JSON.stringify(computeAdvertised(registry))).toBe(wireBefore);
    expect(flushPromotions()).toBe(true);
    const names = computeAdvertised(registry).map((d) => d.name);
    expect(names[names.length - 1]).toBe("mystery_tool");
    expect(names.slice(0, -1)).not.toContain("mystery_tool");
    // A second flush with nothing pending is a no-op so the array holds steady.
    expect(flushPromotions()).toBe(false);
  });

  test("flushPromotions commits pending activations in order and resume re-arms them", () => {
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset(wiring());
    expect(flushPromotions()).toBe(false);
    expect(activated.activate(["tool_b", "tool_a"])).toBe(true);
    expect(flushPromotions()).toBe(true);
    const names = computeAdvertised([
      def("read_file"),
      def("tool_a"),
      def("tool_b"),
    ]).map((d) => d.name);
    expect(names.slice(-2)).toEqual(["tool_b", "tool_a"]);
    // Rotation clears the gate and the wire snapshot; session start replays
    // the restored names (activate) at a cache-safe boundary (flush), so the
    // pending edge stays empty afterwards.
    activated.clear();
    expect(flushPromotions()).toBe(false);
    expect(activated.activate(["tool_a", "tool_b"])).toBe(true);
    expect(flushPromotions()).toBe(true);
    expect(flushPromotions()).toBe(false);
  });

  test("honors an explicit built-in prefix", () => {
    const { computeAdvertised } = createAdvertisedToolset(
      wiring({ builtInPrefix: ["read_file"] }),
    );
    expect(
      computeAdvertised([def("read_file"), def("write_file")]).map(
        (d) => d.name,
      ),
    ).toEqual(["read"]);
  });

  test("parity defs cover native and wire names while the wire set stays byte-identical", () => {
    const native = [
      def("run_shell"),
      def("read_file"),
      def("mcp__linear__save_issue"),
    ];
    const parity = authzParityDefinitions(native);
    const parityNames = new Set(parity.map((d) => d.name));
    for (const name of [
      "run_shell",
      "read_file",
      "mcp__linear__save_issue",
      "bash",
      "shell",
      "read",
    ]) {
      expect(parityNames.has(name)).toBe(true);
    }
    expect(parityNames.has("update_plan")).toBe(false);
    const { computeAdvertised } = createAdvertisedToolset(wiring());
    expect(JSON.stringify(computeAdvertised(parity))).toBe(
      JSON.stringify(computeAdvertised(native)),
    );
    const wireNames = computeAdvertised(parity).map((d) => d.name);
    expect(new Set(wireNames).size).toBe(wireNames.length);
  });

  test("isAdvertised tracks prefix, pinned, and activated names", () => {
    const { activated, isAdvertised } = createAdvertisedToolset(
      wiring({ pinnedTools: ["mcp__linear__save_issue"] }),
    );
    expect(isAdvertised("read_file")).toBe(true);
    expect(isAdvertised("mcp__linear__save_issue")).toBe(true);
    expect(isAdvertised("mcp__acme__do")).toBe(false);
    activated.activate(["mcp__acme__do"]);
    expect(isAdvertised("mcp__acme__do")).toBe(true);
  });

  test("flushPromotions does not commit unadvertised mounted builtins onto the wire", () => {
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset(wiring());
    const registry = [def("read_file"), def("list_dir"), def("mcp__acme__do")];
    expect(activated.activate(["list_dir"])).toBe(true);
    expect(flushPromotions()).toBe(false);
    expect(computeAdvertised(registry).map((d) => d.name)).not.toContain(
      "list_dir",
    );
    expect(activated.activate(["mcp__acme__do"])).toBe(true);
    expect(flushPromotions()).toBe(true);
    const names = computeAdvertised(registry).map((d) => d.name);
    expect(names).not.toContain("list_dir");
    expect(names).toContain("mcp__acme__do");
  });

  test("pruneIdlePromotions drops execute-promoted schemas and keeps the frozen prefix", () => {
    const {
      activated,
      computeAdvertised,
      flushPromotions,
      pruneIdlePromotions,
    } = createAdvertisedToolset(
      wiring({ pinnedTools: ["mcp__linear__save_issue"] }),
    );
    const defs = [
      def("read_file"),
      def("mcp__linear__save_issue"),
      def("mcp__acme__do"),
    ];
    activated.activate(["mcp__acme__do"]);
    expect(flushPromotions()).toBe(true);
    expect(computeAdvertised(defs).map((d) => d.name)).toContain(
      "mcp__acme__do",
    );
    expect(pruneIdlePromotions()).toBe(true);
    const names = computeAdvertised(defs).map((d) => d.name);
    expect(names).not.toContain("mcp__acme__do");
    expect(names).toContain("mcp__linear__save_issue");
    expect(pruneIdlePromotions()).toBe(false);
  });

  test("fold prune persist omits activatedTools from run.json and the crash handle", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fold-prune-persist-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "fold-prune-persist-home-"));
    try {
      const {
        activated,
        computeAdvertised,
        flushPromotions,
        pruneIdlePromotions,
      } = createAdvertisedToolset(wiring());
      const defs = [def("read_file"), def("mcp__acme__do")];
      activated.activate(["mcp__acme__do"]);
      expect(flushPromotions()).toBe(true);

      const sessionId = "fold-prune-persist";
      const base = {
        status: "running" as const,
        turnsUsed: 2,
        task: "task",
        startedAt: 1,
      };
      await saveState(
        cwd,
        sessionId,
        { ...base, activatedTools: activated.list() },
        home,
      );
      const handle: RunStateHandle = {
        sessionId,
        cwd,
        task: base.task,
        startedAt: base.startedAt,
        turnsUsed: base.turnsUsed,
        activatedTools: activated.list(),
      };

      let refreshed = false;
      let persistWrite: Promise<void> | undefined;
      expect(
        commitIdlePromotionPrune({
          pruneIdlePromotions,
          refreshAdvertised: () => {
            refreshed = true;
            expect(computeAdvertised(defs).map((d) => d.name)).not.toContain(
              "mcp__acme__do",
            );
          },
          persist: () => {
            const tools = activated.list();
            syncRunStateHandle(handle, {
              turnsUsed: base.turnsUsed,
              task: base.task,
              startedAt: base.startedAt,
              activatedTools: tools,
            });
            persistWrite = saveState(
              cwd,
              sessionId,
              {
                ...base,
                ...(tools.length > 0 ? { activatedTools: tools } : {}),
              },
              home,
            );
          },
        }),
      ).toBe(true);
      expect(refreshed).toBe(true);
      expect(handle.activatedTools).toEqual([]);
      if (persistWrite === undefined) {
        throw new Error("fold prune persist did not write");
      }
      await persistWrite;

      const loaded = await loadState(cwd, sessionId, home);
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      expect(loaded.state.activatedTools).toBeUndefined();

      expect(
        commitIdlePromotionPrune({
          pruneIdlePromotions,
          refreshAdvertised: () => {
            throw new Error("idle prune must not refresh twice");
          },
          persist: () => {
            throw new Error("idle prune must not persist twice");
          },
        }),
      ).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("pinned tools are advertised before any activation and survive clear", () => {
    const { activated, computeAdvertised } = createAdvertisedToolset(
      wiring({ pinnedTools: ["mcp__linear__save_issue"] }),
    );
    const defs = [def("read_file"), def("mcp__linear__save_issue")];
    expect(computeAdvertised(defs).map((d) => d.name)).toContain(
      "mcp__linear__save_issue",
    );
    // A pinned name is part of the prefix, not the activation set — session
    // rotation clearing activations does not drop it off the wire.
    activated.activate(["mcp__acme__do"]);
    activated.clear();
    const names = computeAdvertised(defs).map((d) => d.name);
    expect(names).toContain("mcp__linear__save_issue");
    expect(names).not.toContain("mcp__acme__do");
  });

  test("primary keeps tool_search for grok/kimi providers (always orchestrator)", () => {
    for (const getProvider of [
      () => ({ providerName: "xai", model: "grok-4-1-fast-non-reasoning" }),
      () => ({ providerName: "moonshot", model: "kimi-k2-0711" }),
    ]) {
      const { computeAdvertised, isAdvertised } = createAdvertisedToolset(
        wiring({ getProvider }),
      );
      const names = computeAdvertised([
        def("tool_search"),
        def("use_skill"),
      ]).map((d) => d.name);
      expect(names).toContain("tool_search");
      expect(names).toContain("skill");
      expect(isAdvertised("tool_search")).toBe(true);
    }
  });
});

describe("loadSessionLocalSettings", () => {
  test("maps a missing local settings file to null without calling onError", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "assemble-runtime-"));
    let errors = 0;
    const settings = await loadSessionLocalSettings({
      cwd,
      globalSettingsPath: join(cwd, "settings.json"),
      onError: () => {
        errors += 1;
      },
    });
    expect(settings).toBeNull();
    expect(errors).toBe(0);
  });
});

function stubCompactor(name: string): Compactor {
  return {
    name,
    version: "1",
    async apply(turns) {
      return {
        output: turns,
        record: {
          strategy: name,
          version: "1",
          parameters: {},
          reason: "test",
          decisions: {},
        },
      };
    },
  };
}

function stubAuditStore(): AuditStore {
  return {
    commitAudit: async () => undefined,
    commitErrors: async () => undefined,
    loadAudit: async () => [],
    loadErrors: async () => [],
  };
}

function stubInferenceDeps(): ChatAgentWiring["inferenceDeps"] {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    scheduler: {
      setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        return () => clearTimeout(handle);
      },
      now: () => performance.now(),
    },
    adapters: {
      has: () => false,
      resolve: () => {
        throw new Error("adapters unused");
      },
    },
  };
}

function stubAuthorize(): ChatAgentWiring["authorize"] {
  return async () => ({
    effect: "allow",
    matchingGrants: [],
    resolvedBy: null,
  });
}

function stubChatAgentWiring(
  overrides: Partial<ChatAgentWiring> = {},
): ChatAgentWiring {
  return {
    toolsId: "test/tools",
    agentId: "test/agent",
    systemPrompt: "prompt",
    authorize: stubAuthorize(),
    getDynamicRunner: () => {
      throw new Error(
        "getDynamicRunner should not run at assemble or mocked build",
      );
    },
    computeAdvertised: () => [],
    inactivityTimeoutMs: 1_000,
    getProvider: () => ({ providerName: "test", model: "m" }),
    getWorkdir: () => "/build-dir",
    getSessionId: () => "test-session",
    inferenceDeps: stubInferenceDeps(),
    getSources: () => [
      {
        id: "s",
        provider: "test",
        baseURL: "http://localhost",
        credentialId: "s",
        model: "m",
      },
    ],
    getDefaultSource: () => "s",
    getCompactor: () => stubCompactor("build"),
    onBuilt: () => undefined,
    ...overrides,
  };
}

type ManifestRecord = {
  strategy: string;
  version: string;
  parameters: Record<string, unknown>;
  reason: string;
  decisions: Record<string, unknown>;
};

function pruningExtrasRecord(extraInstructions: string): ManifestRecord {
  return {
    strategy: "pruning-compactor",
    version: "1",
    parameters: { extraInstructions },
    reason: "compacted",
    decisions: {},
  };
}

function laterManifestRecord(): ManifestRecord {
  return {
    strategy: "other",
    version: "1",
    parameters: {},
    reason: "later",
    decisions: {},
  };
}

async function withAssembledDirector(
  input: {
    getRecords: () => readonly ManifestRecord[];
    directorHolder: { instance?: ChatDirector };
    wiring?: Partial<ChatAgentWiring>;
    beforeCreateSessionStores?: () => void;
    onReadManifestHistory?: (limit: number) => void;
  },
  run: (buildAgent: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const fakeAgent = { close: async () => undefined } as unknown as Agent;
  const fakeStorage = {
    readBlob: async () => new Uint8Array(),
    readManifestHistory: async (limit: number) => {
      input.onReadManifestHistory?.(limit);
      return input.getRecords().slice(0, limit);
    },
  } as unknown as ContextStore;

  await withMockedModuleDuring(
    import.meta.resolve("./optimized-context-store.js"),
    (real: typeof import("./optimized-context-store.js")) => ({
      ...real,
      createSessionStores: async () => {
        input.beforeCreateSessionStores?.();
        return {
          storage: fakeStorage,
          audit: stubAuditStore(),
        };
      },
    }),
    async () => {
      await withMockedModuleDuring(
        import.meta.resolve("../agent/live-tool-dispatch.js"),
        (real: typeof import("../agent/live-tool-dispatch.js")) => ({
          ...real,
          createAgentWithLiveToolDispatch: async (
            _def: unknown,
            env: { directors: DirectorRegistry },
          ) => {
            env.directors.defaultFactory()({}, {} as never, {
              systemPrompt: "prompt",
              toolDefinitions: [],
              compactorNames: ["pruning-compactor"],
            });
            return fakeAgent;
          },
        }),
        async () => {
          const { assembleChatAgent } = await import("./assemble-runtime.js");
          const { buildAgent } = assembleChatAgent(
            stubChatAgentWiring({
              directorHolder: input.directorHolder,
              ...input.wiring,
            }),
          );
          await run(buildAgent);
        },
      );
    },
  );
}

describe("assembleChatAgent", () => {
  test("getWorkdir and getCompactor run at buildAgent time, not assemble time", async () => {
    const storeDirs: string[] = [];
    const agentWorkdirs: string[] = [];
    const agentCompactors: Compactor[] = [];
    const fakeStorage = {
      readBlob: async () => new Uint8Array(),
    } as unknown as ContextStore;
    const fakeAgent = { close: async () => undefined } as unknown as Agent;

    await withMockedModuleDuring(
      import.meta.resolve("./optimized-context-store.js"),
      (real: typeof import("./optimized-context-store.js")) => ({
        ...real,
        createSessionStores: async (dir: string) => {
          storeDirs.push(dir);
          return { storage: fakeStorage, audit: stubAuditStore() };
        },
      }),
      async () => {
        await withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async (
              _def: unknown,
              env: {
                workdir: string;
                compactors: { "pruning-compactor": Compactor };
              },
            ) => {
              agentWorkdirs.push(env.workdir);
              agentCompactors.push(env.compactors["pruning-compactor"]);
              return fakeAgent;
            },
          }),
          async () => {
            const { assembleChatAgent } = await import("./assemble-runtime.js");
            const workdirCalls: string[] = [];
            const compactorCalls: string[] = [];
            let liveDir = "/assemble-dir";
            let liveCompactor = stubCompactor("assemble");

            const { buildAgent } = assembleChatAgent(
              stubChatAgentWiring({
                getWorkdir: () => {
                  workdirCalls.push(liveDir);
                  return liveDir;
                },
                getCompactor: () => {
                  compactorCalls.push(liveCompactor.name);
                  return liveCompactor;
                },
              }),
            );

            expect(workdirCalls).toEqual([]);
            expect(compactorCalls).toEqual([]);
            expect(storeDirs).toEqual([]);
            expect(agentWorkdirs).toEqual([]);

            liveDir = "/build-dir";
            liveCompactor = stubCompactor("build");
            const builtCompactor = liveCompactor;

            await buildAgent();

            expect(workdirCalls).toEqual(["/build-dir"]);
            expect(compactorCalls).toEqual(["build"]);
            expect(storeDirs).toEqual(["/build-dir"]);
            expect(agentWorkdirs).toEqual(["/build-dir"]);
            expect(agentCompactors).toEqual([builtCompactor]);
          },
        );
      },
    );
  });

  test("omits evidence archive when no holder is provided", async () => {
    const fakeStorage = {
      readBlob: async () => new Uint8Array(),
    } as unknown as ContextStore;
    const fakeAgent = { close: async () => undefined } as unknown as Agent;
    const authorize = stubAuthorize();
    let capturedStorage: ContextStore | undefined;
    let capturedAuthorize: unknown;
    let builtAgent: Agent | undefined;
    let builtStorage: ContextStore | undefined;

    await withMockedModuleDuring(
      import.meta.resolve("./optimized-context-store.js"),
      (real: typeof import("./optimized-context-store.js")) => ({
        ...real,
        createSessionStores: async () => ({
          storage: fakeStorage,
          audit: stubAuditStore(),
        }),
      }),
      async () => {
        await withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async (
              _def: unknown,
              env: { storage: ContextStore; authorize: unknown },
            ) => {
              capturedStorage = env.storage;
              capturedAuthorize = env.authorize;
              return fakeAgent;
            },
          }),
          async () => {
            const { assembleChatAgent } = await import("./assemble-runtime.js");
            const { buildAgent } = assembleChatAgent(
              stubChatAgentWiring({
                authorize,
                onBuilt: (agent, storage) => {
                  builtAgent = agent;
                  builtStorage = storage;
                },
              }),
            );
            await buildAgent();
          },
        );
      },
    );

    expect(capturedStorage).toBe(fakeStorage);
    expect(capturedAuthorize).toBe(authorize);
    expect(builtAgent).toBe(fakeAgent);
    expect(builtStorage).toBe(fakeStorage);
  });

  test("rebuild restores extraInstructions from the latest compact record", async () => {
    let records: ManifestRecord[] = [
      pruningExtrasRecord("keep the auth discussion"),
    ];
    const directorHolder: { instance?: ChatDirector } = {};

    await withAssembledDirector(
      { getRecords: () => records, directorHolder },
      async (buildAgent) => {
        await buildAgent();
        expect(directorHolder.instance?.getCompactInstructions()).toBe(
          "keep the auth discussion",
        );
        // /model store-miss on the same session still inherits fromPrev.
        records = [];
        await buildAgent();
        expect(directorHolder.instance?.getCompactInstructions()).toBe(
          "keep the auth discussion",
        );
      },
    );
  });

  test("/clear-like rebuild against an empty store does not inherit extraInstructions", async () => {
    let records: ManifestRecord[] = [
      pruningExtrasRecord("keep the auth discussion"),
    ];
    let workdir = "/session-a";
    let sessionId = "session-a";
    const directorHolder: { instance?: ChatDirector } = {};

    await withAssembledDirector(
      {
        getRecords: () => records,
        directorHolder,
        wiring: {
          getWorkdir: () => workdir,
          getSessionId: () => sessionId,
        },
      },
      async (buildAgent) => {
        await buildAgent();
        expect(directorHolder.instance?.getCompactInstructions()).toBe(
          "keep the auth discussion",
        );
        records = [];
        workdir = "/session-b";
        sessionId = "session-b";
        await buildAgent();
        expect(
          directorHolder.instance?.getCompactInstructions(),
        ).toBeUndefined();
      },
    );
  });

  test("failed /clear rebuild then retry on a new identity does not inherit extraInstructions", async () => {
    let records: ManifestRecord[] = [
      pruningExtrasRecord("keep the auth discussion"),
    ];
    let workdir = "/session-a";
    let sessionId = "session-a";
    let failStores = false;
    const directorHolder: { instance?: ChatDirector } = {};

    await withAssembledDirector(
      {
        getRecords: () => records,
        directorHolder,
        wiring: {
          getWorkdir: () => workdir,
          getSessionId: () => sessionId,
        },
        beforeCreateSessionStores: () => {
          if (failStores) throw new Error("store rebuild failed");
        },
      },
      async (buildAgent) => {
        await buildAgent();
        expect(directorHolder.instance?.getCompactInstructions()).toBe(
          "keep the auth discussion",
        );
        records = [];
        workdir = "/session-b";
        sessionId = "session-b";
        failStores = true;
        await expect(buildAgent()).rejects.toThrow("store rebuild failed");
        failStores = false;
        await buildAgent();
        expect(
          directorHolder.instance?.getCompactInstructions(),
        ).toBeUndefined();
      },
    );
  });

  test("cold resume restores extraInstructions beyond 32 later cycles", async () => {
    const records: ManifestRecord[] = [
      ...Array.from({ length: 32 }, () => laterManifestRecord()),
      pruningExtrasRecord("keep the auth discussion"),
    ];
    const directorHolder: { instance?: ChatDirector } = {};
    const limits: number[] = [];

    await withAssembledDirector(
      {
        getRecords: () => records,
        directorHolder,
        onReadManifestHistory: (limit) => {
          limits.push(limit);
        },
      },
      async (buildAgent) => {
        await buildAgent();
        expect(directorHolder.instance?.getCompactInstructions()).toBe(
          "keep the auth discussion",
        );
        expect(limits).toEqual([32, 64]);
      },
    );
  });
});
