import { defined } from "../testkit/defined.js";
import { describe, expect, test } from "bun:test";
import {
  collectWebPlugins,
  selectWebPlugin,
  resolveWebProviderFromPlugins,
  webBrand,
  type WebPluginCandidate,
} from "./plugin-provider.js";
import type { PluginModule } from "../plugins/loader.js";
import type { WebProvider } from "./types.js";

function stubProvider(name: string): WebProvider {
  return {
    name,
    search: async () => [{ title: "t", url: "https://x", snippet: "s" }],
    fetch: async () => "body",
  };
}

function webModule(id: string, name: string): PluginModule {
  return {
    manifest: {
      id,
      name,
      kind: "web",
      credentials: [{ key: "apiKey", label: "Key", secret: true }],
    },
    createWebProvider: (() => stubProvider(id)) as unknown,
  };
}

describe("collectWebPlugins", () => {
  test("keeps only web-kind modules with a factory", () => {
    const modules: PluginModule[] = [
      webModule("exa", "Exa Search"),
      { manifest: { id: "cmd", name: "Cmd", kind: "command" } },
      { manifest: { id: "broken", name: "Broken", kind: "web" } }, // no factory
    ];
    const candidates = collectWebPlugins(modules);
    expect(candidates.map((c) => c.id)).toEqual(["exa"]);
    expect(defined(defined(candidates[0]).credentials[0]).key).toBe("apiKey");
  });
});

describe("selectWebPlugin", () => {
  const candidates: WebPluginCandidate[] = [
    {
      id: "exa",
      name: "Exa Search",
      credentials: [],
      factory: () => stubProvider("exa"),
    },
    {
      id: "other",
      name: "Other",
      credentials: [],
      factory: () => stubProvider("other"),
    },
  ];

  test("override wins; otherwise exactly one enabled plugin is required", () => {
    const cases: {
      config: Parameters<typeof selectWebPlugin>[1];
      override: string | undefined;
      expected: string | undefined;
    }[] = [
      { config: {}, override: "other", expected: "other" },
      {
        config: { exa: { enabled: true } },
        override: undefined,
        expected: "exa",
      },
      // ambiguous: multiple enabled, no override
      {
        config: { exa: { enabled: true }, other: { enabled: true } },
        override: undefined,
        expected: undefined,
      },
      { config: {}, override: undefined, expected: undefined },
    ];
    for (const { config, override, expected } of cases) {
      expect(selectWebPlugin(candidates, config, override)?.id).toBe(expected);
    }
  });
});

describe("resolveWebProviderFromPlugins", () => {
  test("builds the selected provider with stored credentials", async () => {
    const candidates = collectWebPlugins([webModule("exa", "Exa Search")]);
    const active = await resolveWebProviderFromPlugins({
      candidates,
      pluginConfig: { exa: { enabled: true, credentials: { apiKey: "k" } } },
      webOverride: undefined,
    });
    expect(active?.name).toBe("Exa Search");
    expect(active?.provider.name).toBe("exa");
  });

  test("returns undefined (falls back to local) when the factory throws", async () => {
    const candidates: WebPluginCandidate[] = [
      {
        id: "exa",
        name: "Exa Search",
        credentials: [],
        factory: () => {
          throw new Error("bad key");
        },
      },
    ];
    const active = await resolveWebProviderFromPlugins({
      candidates,
      pluginConfig: {},
      webOverride: "exa",
    });
    expect(active).toBeUndefined();
  });
});

describe("webBrand", () => {
  test("strips trailing Search/Fetch", () => {
    expect(webBrand("Exa Search")).toBe("Exa");
    expect(webBrand("Tavily Fetch")).toBe("Tavily");
    expect(webBrand("Brave")).toBe("Brave");
  });
});
