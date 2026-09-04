import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@intx/agent";
import type { Compactor, ContextStore, ToolDefinition } from "@intx/types/runtime";

import { withMockedModuleDuring } from "../../tests/helpers/mock-module.js";
import {
  createAdvertisedToolset,
  loadSessionLocalSettings,
  type ChatAgentWiring,
} from "./assemble-runtime.js";

function def(name: string): ToolDefinition {
  return { name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } };
}

function wiring(overrides: Partial<Parameters<typeof createAdvertisedToolset>[0]> = {}) {
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
    const names = computeAdvertised([def("write_file"), def("mystery_tool")]).map((d) => d.name);
    expect(names).toContain("write_file");
    expect(names).not.toContain("mystery_tool");
  });

  test("appends activated tools after the prefix, in activation order", () => {
    const { activated, computeAdvertised } = createAdvertisedToolset(wiring());
    expect(activated.activate(["mystery_tool"])).toBe(true);
    const names = computeAdvertised([def("read_file"), def("mystery_tool")]).map((d) => d.name);
    expect(names[names.length - 1]).toBe("mystery_tool");
    expect(names.slice(0, -1)).not.toContain("mystery_tool");
  });

  test("honors an explicit built-in prefix", () => {
    const { computeAdvertised } = createAdvertisedToolset(wiring({ builtInPrefix: ["read_file"] }));
    expect(computeAdvertised([def("read_file"), def("write_file")]).map((d) => d.name)).toEqual([
      "read_file",
    ]);
  });

  test("advertises nothing from an empty registry", () => {
    const { computeAdvertised } = createAdvertisedToolset(wiring());
    expect(computeAdvertised([])).toEqual([]);
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

describe("assembleChatAgent", () => {
  test("getWorkdir and getCompactor run at buildAgent time, not assemble time", async () => {
    const storeDirs: string[] = [];
    const agentWorkdirs: string[] = [];
    const agentCompactors: Compactor[] = [];
    const fakeStorage = {
      readBlob: async () => new Uint8Array(),
    } as unknown as ContextStore;
    const fakeAgent = { close: async () => {} } as unknown as Agent;

    await withMockedModuleDuring(
      import.meta.resolve("./optimized-context-store.js"),
      (real: typeof import("./optimized-context-store.js")) => ({
        ...real,
        createOptimizedContextStore: async (dir: string) => {
          storeDirs.push(dir);
          return fakeStorage;
        },
      }),
      async () => {
        await withMockedModuleDuring(
          import.meta.resolve("../agent/live-tool-dispatch.js"),
          (real: typeof import("../agent/live-tool-dispatch.js")) => ({
            ...real,
            createAgentWithLiveToolDispatch: async (
              _def: unknown,
              env: { workdir: string; compactors: { "pruning-compactor": Compactor } },
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

            const { buildAgent } = assembleChatAgent({
              toolsId: "test/tools",
              agentId: "test/agent",
              systemPrompt: "prompt",
              getDynamicRunner: () => {
                throw new Error("getDynamicRunner should not run at assemble or mocked build");
              },
              computeAdvertised: () => [],
              activateTools: () => false,
              inactivityTimeoutMs: 1_000,
              onTasksChange: () => {},
              requestContinuation: () => {},
              getProvider: () => ({ providerName: "test", model: "m" }),
              getWorkdir: () => {
                workdirCalls.push(liveDir);
                return liveDir;
              },
              inferenceDeps: stubInferenceDeps(),
              getSources: () => [
                {
                  id: "s",
                  provider: "test",
                  baseURL: "http://localhost",
                  apiKey: "k",
                  model: "m",
                },
              ],
              getDefaultSource: () => "s",
              getCompactor: () => {
                compactorCalls.push(liveCompactor.name);
                return liveCompactor;
              },
              onBuilt: () => {},
            });

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
});
