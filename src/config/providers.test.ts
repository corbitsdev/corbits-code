import { describe, expect, test } from "bun:test";

import type { ProviderCatalogEntry } from "./index.js";
import { buildProviderEntry } from "./providers.js";

const baseCatalog: ProviderCatalogEntry[] = [
  {
    name: "bf",
    baseURL: "http://localhost:8080/v1",
    apiKey: "sk-bf-existing",
    models: ["m1"],
    bifrostVirtualKey: true,
  },
  {
    name: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-openai",
    models: ["gpt-4o"],
  },
];

describe("buildProviderEntry bifrostVirtualKey preserve-on-edit", () => {
  test("keeps existing bifrostVirtualKey when submission omits the flag", () => {
    const result = buildProviderEntry(
      {
        name: "bf",
        originalName: "bf",
        baseURL: "http://localhost:8080/v1",
        models: ["m1", "m2"],
      },
      baseCatalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.bifrostVirtualKey).toBe(true);
  });

  test("omits bifrostVirtualKey when existing entry has no flag", () => {
    const result = buildProviderEntry(
      {
        name: "openai",
        originalName: "openai",
        baseURL: "https://api.openai.com/v1",
        models: ["gpt-4o-mini"],
      },
      baseCatalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.bifrostVirtualKey).toBeUndefined();
  });
});
