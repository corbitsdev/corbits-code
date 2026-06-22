import { test, expect } from "bun:test";
import { createSourceRegistry } from "@intx/agent";
import { buildMainSessionSources } from "../../src/config/inference-sources.js";
import type { ProviderCatalogEntry } from "../../src/config/index.js";
import type { Settings } from "../../src/config/settings.js";

const catalog: ProviderCatalogEntry[] = [
  {
    name: "primary",
    baseURL: "https://primary.test/v1",
    apiKey: "pk",
    models: ["big"],
    defaultModel: "big",
  },
  {
    name: "fallback",
    baseURL: "https://fallback.test/v1",
    apiKey: "fk",
    models: ["small"],
    defaultModel: "small",
  },
];

test("main session source list matches agent registry failover order", () => {
  const settings: Settings = {
    providers: {
      primary: { baseURL: catalog[0]!.baseURL, apiKey: "pk", models: ["big"] },
      fallback: { baseURL: catalog[1]!.baseURL, apiKey: "fk", models: ["small"] },
    },
    tiers: {
      standard: {
        mode: "pin",
        order: [{ provider: "fallback", model: "small" }],
      },
    },
  };

  const bundle = buildMainSessionSources({
    settings,
    catalog,
    activeProvider: "primary",
    activeModel: "big",
    sessionId: "sess",
  });

  expect(bundle.sources.map((s) => s.id)).toEqual(["primary", "fallback"]);
  expect(bundle.defaultSource).toBe("primary");

  const reg = createSourceRegistry({
    sources: bundle.sources,
    defaultSource: bundle.defaultSource,
  });
  expect(reg.active.id).toBe("primary");
  expect(reg.failOverToNextSource()).toBe(true);
  expect(reg.active.id).toBe("fallback");
  expect(reg.failOverToNextSource()).toBe(false);
});