import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import {
  buildProviderContextWindowOverrides,
  contextWindowFor,
  hasContextWindowFor,
  setModelContextWindows,
  setProviderContextWindowOverrides,
} from "./context-window.js";

describe("contextWindowFor", () => {
  afterEach(() => {
    setModelContextWindows(undefined);
    setProviderContextWindowOverrides(undefined);
  });

  it("resolves a custom-provider-prefixed id against the bare model registry entry", () => {
    setModelContextWindows({ "grok-4.5": 500_000 });
    expect(contextWindowFor("xai/thegreataxios:grok-4.5")).toBe(500_000);
  });

  it("resolves a custom-provider-prefixed id against the canonical provider/model entry", () => {
    setModelContextWindows({ "xai/grok-4.5": 500_000 });
    expect(contextWindowFor("xai/thegreataxios:grok-4.5")).toBe(500_000);
  });

  it("falls back to a grok/xai heuristic window when the registry has no entry", () => {
    setModelContextWindows(undefined);
    expect(contextWindowFor("xai/thegreataxios:grok-4.5")).toBe(256_000);
  });

  it("reports low confidence when a miss falls through to the heuristic", () => {
    setModelContextWindows(undefined);
    expect(hasContextWindowFor("xai/thegreataxios:grok-4.5")).toBe(false);
  });

  it("reports confidence when the registry has a matching entry", () => {
    setModelContextWindows({ "grok-4.5": 500_000 });
    expect(hasContextWindowFor("xai/thegreataxios:grok-4.5")).toBe(true);
  });

  it("lets a provider override beat models.dev registry metadata", () => {
    setModelContextWindows({ "fp-large": 200_000 });
    setProviderContextWindowOverrides({ "fp-large": 32_000 });
    expect(contextWindowFor("fp-large")).toBe(32_000);
    expect(contextWindowFor("firepass:fp-large")).toBe(32_000);
  });

  it("lets a provider override beat the family heuristic", () => {
    setProviderContextWindowOverrides({ "claude-sonnet": 8_000 });
    expect(contextWindowFor("claude-sonnet")).toBe(8_000);
  });

  it("keeps the override across a later models.dev registry replace", () => {
    setProviderContextWindowOverrides({ "fp-large": 32_000 });
    setModelContextWindows({ "fp-large": 200_000 });
    expect(contextWindowFor("fp-large")).toBe(32_000);
  });

  it("reports confidence for an override even when the registry is empty", () => {
    setProviderContextWindowOverrides({ "fp-large": 32_000 });
    expect(hasContextWindowFor("fp-large")).toBe(true);
    expect(hasContextWindowFor("firepass:fp-large")).toBe(true);
  });
});

describe("buildProviderContextWindowOverrides", () => {
  it("keys <provider>:<model> for every model and the bare id only for the resolved provider", () => {
    const overrides = buildProviderContextWindowOverrides(
      {
        firepass: {
          models: ["fp-large", "fp-small"],
          contextWindow: 32_000,
        },
        other: {
          models: ["fp-large", "other-model"],
          contextWindow: 64_000,
        },
        skipped: {
          models: ["no-window"],
        },
      },
      "firepass",
      "fp-large",
    );
    expect(overrides).toEqual({
      "firepass:fp-large": 32_000,
      "firepass:fp-small": 32_000,
      "fp-large": 32_000,
      "fp-small": 32_000,
      "other:fp-large": 64_000,
      "other:other-model": 64_000,
    });
  });

  it("includes the resolved model even when it is not in the provider model list", () => {
    const overrides = buildProviderContextWindowOverrides(
      {
        firepass: { models: ["fp-large"], contextWindow: 32_000 },
      },
      "firepass",
      "fp-cli",
    );
    expect(overrides["firepass:fp-cli"]).toBe(32_000);
    expect(overrides["fp-cli"]).toBe(32_000);
  });

  it("skips non-positive windows", () => {
    expect(
      buildProviderContextWindowOverrides(
        {
          firepass: { models: ["fp-large"], contextWindow: 0 },
          other: { models: ["m"], contextWindow: -1 },
        },
        "firepass",
        "fp-large",
      ),
    ).toEqual({});
  });
});

describe("loadConfig provider contextWindow", () => {
  afterEach(() => {
    setModelContextWindows(undefined);
    setProviderContextWindowOverrides(undefined);
  });

  it("applies providers.<name>.contextWindow after resolveProvider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ic-cw-"));
    const globalPath = join(cwd, "global.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        defaultProvider: "firepass",
        providers: {
          firepass: {
            baseURL: "https://firepass.example/v1",
            apiKey: "test-key",
            models: ["fp-large", "fp-small"],
            defaultModel: "fp-large",
            contextWindow: 32_000,
          },
          other: {
            baseURL: "https://other.example/v1",
            apiKey: "other-key",
            models: ["fp-large"],
            contextWindow: 64_000,
          },
        },
      }),
    );

    setModelContextWindows({ "fp-large": 200_000 });
    await loadConfig(["--cwd", cwd, "hello"], {
      globalSettingsPath: globalPath,
    });

    expect(contextWindowFor("firepass:fp-large")).toBe(32_000);
    expect(contextWindowFor("fp-large")).toBe(32_000);
    expect(contextWindowFor("firepass:fp-small")).toBe(32_000);
    expect(contextWindowFor("other:fp-large")).toBe(64_000);
  });
});
