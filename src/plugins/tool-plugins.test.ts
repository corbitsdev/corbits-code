import { describe, test, expect } from "bun:test";
import { collectToolPlugins, isToolPluginActive, resolveToolPlugins, type ToolPluginCandidate } from "./tool-plugins.js";
import type { PluginModule } from "./loader.js";

function toolModule(id: string): PluginModule {
  return {
    manifest: { id, name: id, kind: "tool", credentials: [{ key: "apiKey", label: "Key", secret: true }] },
    createToolPlugin: ((opts: { apiKey?: string }) => ({
      tools: [{ definition: { name: `${id}_tool`, description: "d", inputSchema: { type: "object", properties: {} } }, handler: async () => ({ callId: "c", content: opts.apiKey ?? "" }) }],
    })) as unknown,
  };
}

describe("collectToolPlugins", () => {
  test("keeps only tool-kind modules with a factory", () => {
    const mods: PluginModule[] = [
      toolModule("t1"),
      { manifest: { id: "w", name: "w", kind: "web" }, createWebProvider: (() => ({})) as unknown },
      { manifest: { id: "broken", name: "b", kind: "tool" } }, // no factory
    ];
    expect(collectToolPlugins(mods).map((c) => c.id)).toEqual(["t1"]);
  });
});

describe("isToolPluginActive", () => {
  test("requires both enabled and consented", () => {
    expect(isToolPluginActive({ t: { enabled: true, consented: true } }, "t")).toBe(true);
    expect(isToolPluginActive({ t: { enabled: true } }, "t")).toBe(false);
    expect(isToolPluginActive({ t: { consented: true } }, "t")).toBe(false);
    expect(isToolPluginActive({}, "t")).toBe(false);
  });
});

describe("resolveToolPlugins", () => {
  test("instantiates only enabled+consented plugins with their credentials", async () => {
    const candidates = collectToolPlugins([toolModule("t1"), toolModule("t2")]);
    const plugins = await resolveToolPlugins({
      candidates,
      pluginConfig: { t1: { enabled: true, consented: true, credentials: { apiKey: "k1" } }, t2: { enabled: true } },
    });
    expect(plugins.length).toBe(1);
    expect(plugins[0]!.tools![0]!.definition.name).toBe("t1_tool");
  });

  test("a throwing factory is skipped, not fatal", async () => {
    const candidates: ToolPluginCandidate[] = [
      { id: "bad", name: "bad", credentials: [], factory: () => { throw new Error("boom"); } },
    ];
    const plugins = await resolveToolPlugins({ candidates, pluginConfig: { bad: { enabled: true, consented: true } } });
    expect(plugins).toEqual([]);
  });
});
