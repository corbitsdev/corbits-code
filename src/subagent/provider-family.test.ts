import { describe, expect, test } from "bun:test";
import {
  detectModelFamily,
  isClaudeLeafProvider,
  isKimiLeafProvider,
  isXaiGrokLeafProvider,
  shouldApplyGrokAntiThrash,
} from "./provider-family.js";

describe("isXaiGrokLeafProvider", () => {
  test("matches xai/ OAuth provider names", () => {
    expect(isXaiGrokLeafProvider({ providerName: "xai/default" })).toBe(true);
    expect(isXaiGrokLeafProvider({ providerName: "xai/work" })).toBe(true);
  });

  test("matches grok-responses adapter id", () => {
    expect(isXaiGrokLeafProvider({ providerName: "grok-responses" })).toBe(
      true,
    );
  });

  test("matches model ids that start with grok", () => {
    expect(
      isXaiGrokLeafProvider({
        providerName: "openai-compat",
        model: "grok-4.5",
      }),
    ).toBe(true);
  });

  test("rejects codex and generic providers", () => {
    expect(
      isXaiGrokLeafProvider({ providerName: "codex", model: "gpt-5.1" }),
    ).toBe(false);
    expect(
      isXaiGrokLeafProvider({
        providerName: "anthropic",
        model: "claude-sonnet-4",
      }),
    ).toBe(false);
    expect(
      isXaiGrokLeafProvider({ providerName: "openai", model: "gpt-5.6" }),
    ).toBe(false);
  });

  test("matches xai/ OAuth provider names regardless of case", () => {
    expect(isXaiGrokLeafProvider({ providerName: "XAI/default" })).toBe(true);
  });
});

describe("shouldApplyGrokAntiThrash", () => {
  test("applies the residual to a Grok leaf worker", () => {
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "xai/default",
        orchestrator: false,
      }),
    ).toBe(true);
  });

  test("withholds the residual from a Grok orchestrator", () => {
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "xai/default",
        orchestrator: true,
      }),
    ).toBe(false);
  });

  test("withholds the residual from non-Grok leaves", () => {
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "anthropic",
        orchestrator: false,
      }),
    ).toBe(false);
  });
});

describe("isKimiLeafProvider", () => {
  test("matches moonshot provider names and kimi model ids", () => {
    expect(isKimiLeafProvider({ providerName: "moonshot" })).toBe(true);
    expect(
      isKimiLeafProvider({ providerName: "openai-compat", model: "kimi-k2" }),
    ).toBe(true);
  });

  test("matches OpenCode Go + kimi-k3 via model id", () => {
    expect(
      isKimiLeafProvider({ providerName: "opencode-go", model: "kimi-k3" }),
    ).toBe(true);
    expect(
      detectModelFamily({ providerName: "opencode-go", model: "kimi-k3" }),
    ).toBe("kimi");
  });

  // In-tree OpenCode Go kimi catalog ids (packages/opencode-go/src/models.ts).
  // Gate keeps /^kimi/ model-id match — list them so a new Go kimi id is covered.
  test("covers all in-tree OpenCode Go kimi model ids", () => {
    const goKimiModelIds = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"] as const;
    for (const model of goKimiModelIds) {
      expect(isKimiLeafProvider({ providerName: "opencode-go", model })).toBe(
        true,
      );
      expect(detectModelFamily({ providerName: "opencode-go", model })).toBe(
        "kimi",
      );
    }
  });

  test("rejects unrelated providers", () => {
    expect(
      isKimiLeafProvider({
        providerName: "anthropic",
        model: "claude-sonnet-4",
      }),
    ).toBe(false);
    expect(
      isKimiLeafProvider({ providerName: "opencode-go", model: "gpt-5.1" }),
    ).toBe(false);
  });
});

describe("detectModelFamily", () => {
  test("detects grok, kimi, claude, and default", () => {
    expect(
      detectModelFamily({ providerName: "xai/default", model: "grok-4.5" }),
    ).toBe("grok");
    expect(
      detectModelFamily({ providerName: "xai/default", model: "grok-4.6" }),
    ).toBe("grok");
    expect(
      detectModelFamily({ providerName: "moonshot", model: "kimi-k2" }),
    ).toBe("kimi");
    expect(
      detectModelFamily({
        providerName: "anthropic",
        model: "claude-sonnet-4",
      }),
    ).toBe("claude");
    expect(
      detectModelFamily({
        providerName: "unknown-provider",
        model: "unknown-model",
      }),
    ).toBe("default");
  });
});

describe("isClaudeLeafProvider", () => {
  test("matches anthropic provider names and claude model ids", () => {
    expect(isClaudeLeafProvider({ providerName: "anthropic" })).toBe(true);
    expect(isClaudeLeafProvider({ providerName: "ANTHROPIC" })).toBe(true);
    expect(
      isClaudeLeafProvider({
        providerName: "openai-compat",
        model: "claude-sonnet-4",
      }),
    ).toBe(true);
  });

  test("rejects grok, gpt, kimi, and muse rows", () => {
    expect(
      isClaudeLeafProvider({ providerName: "xai/default", model: "grok-4.5" }),
    ).toBe(false);
    expect(
      isClaudeLeafProvider({ providerName: "openai", model: "gpt-5.6" }),
    ).toBe(false);
    expect(
      isClaudeLeafProvider({ providerName: "codex", model: "gpt-5.1" }),
    ).toBe(false);
    expect(
      isClaudeLeafProvider({ providerName: "moonshot", model: "kimi-k2" }),
    ).toBe(false);
    expect(
      isClaudeLeafProvider({
        providerName: "opencode-go/abklabs",
        model: "muse-spark-1.3-contributor",
      }),
    ).toBe(false);
  });
});

describe("detectModelFamily claude row", () => {
  test("resolves anthropic/claude to the claude family", () => {
    expect(
      detectModelFamily({
        providerName: "anthropic",
        model: "claude-sonnet-4",
      }),
    ).toBe("claude");
    expect(
      detectModelFamily({
        providerName: "openai-compat",
        model: "claude-opus-4-6",
      }),
    ).toBe("claude");
  });
});
