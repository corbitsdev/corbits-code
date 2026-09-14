import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@intx/agent";
import type {
  AuditStore,
  Compactor,
  ContextStore,
  ToolDefinition,
} from "@intx/types/runtime";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import {
  createAdvertisedToolset,
  loadSessionLocalSettings,
  type ChatAgentWiring,
} from "./assemble-runtime.js";

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
    expect(names).toContain("write_file");
    expect(names).not.toContain("mystery_tool");
  });

  // CL-7868 (direction A): mid-session activation opens the call gate but must
  // not reshape the wire set, so computeAdvertised ignores it until a
  // cache-safe boundary commits it via flushPromotions.
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
    // Rotation clears the gate and the wire snapshot; session start replays the
    // restored names (activate) at a cache-safe boundary (flush), re-arming
    // both while the pending edge stays empty afterwards.
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
    ).toEqual(["read_file"]);
  });

  test("advertises nothing from an empty registry", () => {
    const { computeAdvertised } = createAdvertisedToolset(wiring());
    expect(computeAdvertised([])).toEqual([]);
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

  test("primary keeps skill_search for grok/kimi providers (always orchestrator; leaf deny lives at the worker mount)", () => {
    for (const getProvider of [
      () => ({ providerName: "xai", model: "grok-4-1-fast-non-reasoning" }),
      () => ({ providerName: "moonshot", model: "kimi-k2-0711" }),
    ]) {
      const { computeAdvertised, isAdvertised } = createAdvertisedToolset(
        wiring({ getProvider }),
      );
      const names = computeAdvertised([
        def("skill_search"),
        def("use_skill"),
      ]).map((d) => d.name);
      expect(names).toContain("skill_search");
      expect(names).toContain("use_skill");
      expect(isAdvertised("skill_search")).toBe(true);
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
    requestContinuation: () => undefined,
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
});
