import { describe, test, expect } from "bun:test";
import { toAgentProviders, validateProviderForm, type ProviderFormValues } from "./agent-modal.js";

describe("toAgentProviders", () => {
  test("projects editable provider fields and drops API keys", () => {
    const result = toAgentProviders([
      { name: "fp", baseURL: "https://fp/v1", apiKey: "sk-secret", models: ["a", "b"], defaultModel: "a" },
    ]);
    expect(result).toEqual([{ name: "fp", baseURL: "https://fp/v1", models: ["a", "b"], defaultModel: "a" }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("sk-secret");
  });

  test("omits defaultModel when absent", () => {
    const result = toAgentProviders([{ name: "solo", baseURL: "https://solo/v1", models: ["only"] }]);
    expect(result[0]).toEqual({ name: "solo", baseURL: "https://solo/v1", models: ["only"] });
    expect("defaultModel" in result[0]!).toBe(false);
  });
});

const form = (overrides: Partial<ProviderFormValues> = {}): ProviderFormValues => ({
  name: "firepass",
  baseURL: "https://firepass.example/v1",
  apiKey: "sk-key",
  models: "fp-large, fp-small",
  defaultModel: "fp-large",
  ...overrides,
});

describe("validateProviderForm", () => {
  test("creates a provider submission from comma-separated models", () => {
    const result = validateProviderForm(form(), undefined);
    expect(result).toEqual({
      ok: true,
      submission: {
        name: "firepass",
        baseURL: "https://firepass.example/v1",
        apiKey: "sk-key",
        models: ["fp-large", "fp-small"],
        defaultModel: "fp-large",
      },
    });
  });

  test("requires an API key when adding a provider", () => {
    expect(validateProviderForm(form({ apiKey: "" }), undefined)).toEqual({
      ok: false,
      error: "API key is required",
    });
  });

  test("allows an empty API key when editing a provider", () => {
    const result = validateProviderForm(form({ apiKey: "" }), "firepass");
    expect(result).toEqual({
      ok: true,
      submission: {
        originalName: "firepass",
        name: "firepass",
        baseURL: "https://firepass.example/v1",
        models: ["fp-large", "fp-small"],
        defaultModel: "fp-large",
      },
    });
  });

  test("rejects a default model that is not in the model list", () => {
    expect(validateProviderForm(form({ defaultModel: "missing" }), "firepass")).toEqual({
      ok: false,
      error: "Default model must be listed in models",
    });
  });
});
