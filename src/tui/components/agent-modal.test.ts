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
  keyless: "no",
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

  test("requires an API key when adding a non-keyless provider", () => {
    expect(validateProviderForm(form({ apiKey: "" }), undefined)).toEqual({
      ok: false,
      error: "API key is required (or enable keyless)",
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

  test("allows a keyless provider with no API key when adding", () => {
    const result = validateProviderForm(form({ keyless: "yes", apiKey: "" }), undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submission.keyless).toBe(true);
      expect(result.submission.apiKey).toBeUndefined();
    }
  });

  test("does not set keyless when the toggle is no", () => {
    const result = validateProviderForm(form({ keyless: "no" }), undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.submission.keyless).toBeUndefined();
    }
  });

test("trims leading and trailing spaces on text fields at save", () => {
    const result = validateProviderForm(
      form({
        name: "  firepass  ",
        baseURL: "  https://firepass.example/v1  ",
        apiKey: "  sk-key  ",
        models: "  fp-large , fp-small  ",
        defaultModel: "  fp-large  ",
      }),
      undefined,
    );
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

  test("persists anthropic and opencodeGo flags from connect extras", () => {
    const anthropic = validateProviderForm(form({ name: "anthropic" }), undefined, {
      anthropic: true,
    });
    expect(anthropic.ok).toBe(true);
    if (anthropic.ok) {
      expect(anthropic.submission.anthropic).toBe(true);
      expect(anthropic.submission.opencodeGo).toBeUndefined();
    }

    const go = validateProviderForm(
      form({ name: "opencode-go", apiKey: "sk-go-longenough" }),
      undefined,
      { opencodeGo: true },
    );
    expect(go.ok).toBe(true);
    if (go.ok) {
      expect(go.submission.opencodeGo).toBe(true);
    }
  });

  test("rejects invalid OpenCode Go API keys when opencodeGo is set", () => {
    expect(
      validateProviderForm(form({ name: "opencode-go", apiKey: "short" }), undefined, {
        opencodeGo: true,
      }),
    ).toEqual({ ok: false, error: "API key looks too short" });

    expect(
      validateProviderForm(form({ name: "opencode-go", apiKey: "has space" }), undefined, {
        opencodeGo: true,
      }),
    ).toEqual({ ok: false, error: "API key must not contain whitespace" });
  });
});
