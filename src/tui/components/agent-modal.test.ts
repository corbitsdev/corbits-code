import { describe, test, expect } from "bun:test";
import {
  seedConnectForm,
  toAgentProviders,
  validateProviderForm,
  type ProviderFormValues,
} from "./agent-modal.js";
import { FIRST_CLASS_PROVIDERS } from "../../../packages/first-class-providers/src/index.js";

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

  test("edit submission re-asserts protocol flags from provider extras", () => {
    // Mirrors enterEditForm seeding connectDraft from AgentProvider flags.
    const goEdit = validateProviderForm(
      form({
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        apiKey: "",
        models: "kimi-k2.7-code, minimax-m3",
        defaultModel: "kimi-k2.7-code",
      }),
      "opencode-go",
      { opencodeGo: true },
    );
    expect(goEdit.ok).toBe(true);
    if (goEdit.ok) {
      expect(goEdit.submission.originalName).toBe("opencode-go");
      expect(goEdit.submission.opencodeGo).toBe(true);
    }

    const anthropicEdit = validateProviderForm(
      form({ name: "anthropic", baseURL: "https://api.anthropic.com" }),
      "anthropic",
      { anthropic: true },
    );
    expect(anthropicEdit.ok).toBe(true);
    if (anthropicEdit.ok) {
      expect(anthropicEdit.submission.anthropic).toBe(true);
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

describe("seedConnectForm", () => {
  const goDef = FIRST_CLASS_PROVIDERS.find((p) => p.id === "opencode-go");
  if (goDef === undefined) throw new Error("opencode-go missing from FIRST_CLASS_PROVIDERS");
  const zenDef = FIRST_CLASS_PROVIDERS.find((p) => p.id === "zen");
  if (zenDef === undefined) throw new Error("zen missing from FIRST_CLASS_PROVIDERS");

  test("creates a new provider submission path when catalog is empty", () => {
    const seed = seedConnectForm(goDef, undefined);
    expect(seed.editingProvider).toBeUndefined();
    expect(seed.formValues.name).toBe("opencode-go");
    expect(seed.connectDraft.opencodeGo).toBe(true);
    expect(seed.formValues.apiKey).toBe("");
  });

  test("treats re-Connect as edit so save upserts instead of name-conflict", () => {
    const seed = seedConnectForm(goDef, {
      name: "opencode-go",
      baseURL: "https://opencode.ai/zen/go/v1",
      models: ["kimi-k2.7-code"],
      defaultModel: "kimi-k2.7-code",
      opencodeGo: true,
    });
    expect(seed.editingProvider).toBe("opencode-go");
    expect(seed.connectDraft.opencodeGo).toBe(true);
    // Go re-connect seeds catalog models; only the key is re-entered.
    expect(seed.formValues.baseURL).toBe(goDef.baseURL ?? "");
    expect(seed.formValues.apiKey).toBe("");

    const validated = validateProviderForm(
      { ...seed.formValues, apiKey: "sk-go-rotated-key-long" },
      seed.editingProvider,
      seed.connectDraft,
    );
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.submission.originalName).toBe("opencode-go");
      expect(validated.submission.opencodeGo).toBe(true);
      expect(validated.submission.apiKey).toBe("sk-go-rotated-key-long");
    }
  });

  test("does not re-seed a wrong Zen PAYG baseURL for OpenCode Go", () => {
    const seed = seedConnectForm(goDef, {
      name: "opencode-go",
      baseURL: "https://opencode.ai/zen/v1",
      models: ["wrong-model"],
      defaultModel: "wrong-model",
      opencodeGo: true,
    });
    expect(seed.formValues.baseURL).toBe(goDef.baseURL ?? "");
    expect(seed.formValues.baseURL).not.toBe("https://opencode.ai/zen/v1");
    // Catalog models/default, not the stale existing values.
    expect(seed.formValues.models).toBe((goDef.models ?? []).join(", "));
    expect(seed.formValues.defaultModel).toBe(goDef.defaultModel ?? goDef.models?.[0] ?? "");
    expect(seed.connectDraft.opencodeGo).toBe(true);
  });

  test("zen re-connect always seeds catalog baseURL", () => {
    const seed = seedConnectForm(zenDef, {
      name: "zen",
      baseURL: "https://opencode.ai/zen/go/v1",
      models: ["claude-sonnet-4-5"],
      defaultModel: "claude-sonnet-4-5",
    });
    expect(seed.formValues.baseURL).toBe(zenDef.baseURL ?? "");
    expect(seed.formValues.baseURL).toBe("https://opencode.ai/zen/v1");
    // Operator-customized models still kept for zen.
    expect(seed.formValues.models).toBe("claude-sonnet-4-5");
  });
});
