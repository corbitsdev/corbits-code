import { describe, expect, test } from "bun:test";
import {
  detectModelFamily,
  isClaudeLeafProvider,
  isGptProvider,
  isKimiLeafProvider,
  isXaiGrokLeafProvider,
  shouldApplyGrokAntiThrash,
} from "./provider-family.js";
import { CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js";

interface ProviderRow {
  providerName: string;
  model?: string;
}

describe("isXaiGrokLeafProvider", () => {
  test.each<[ProviderRow, boolean]>([
    [{ providerName: "xai/default" }, true],
    [{ providerName: "xai/work" }, true],
    [{ providerName: "XAI/default" }, true],
    [{ providerName: "grok-responses" }, true],
    [{ providerName: "openai-compat", model: "grok-4.5" }, true],
    [{ providerName: "codex", model: "gpt-5.1" }, false],
    [{ providerName: "anthropic", model: "claude-sonnet-4" }, false],
    [{ providerName: "openai", model: "gpt-5.6" }, false],
  ])("matches %j -> %s", (row, expected) => {
    expect(isXaiGrokLeafProvider(row)).toBe(expected);
  });
});

describe("shouldApplyGrokAntiThrash", () => {
  test.each<[ProviderRow & { orchestrator: boolean }, boolean]>([
    [{ providerName: "xai/default", orchestrator: false }, true],
    [{ providerName: "xai/default", orchestrator: true }, false],
    [{ providerName: "anthropic", orchestrator: false }, false],
  ])("on %j -> %s", (row, expected) => {
    expect(shouldApplyGrokAntiThrash(row)).toBe(expected);
  });
});

describe("isKimiLeafProvider", () => {
  test.each<[ProviderRow, boolean]>([
    [{ providerName: "moonshot" }, true],
    [{ providerName: "openai-compat", model: "kimi-k2" }, true],
    [{ providerName: "opencode-go", model: "kimi-k3" }, true],
    [{ providerName: "anthropic", model: "claude-sonnet-4" }, false],
    [{ providerName: "opencode-go", model: "gpt-5.1" }, false],
  ])("matches %j -> %s", (row, expected) => {
    expect(isKimiLeafProvider(row)).toBe(expected);
  });

  // In-tree OpenCode Go kimi catalog ids (packages/opencode-go/src/models.ts).
  // Gate keeps /^kimi/ model-id match — list them so a new Go kimi id is covered.
  test.each<[string]>([["kimi-k3"], ["kimi-k2.7-code"], ["kimi-k2.6"]])(
    "covers in-tree OpenCode Go kimi model id %s",
    (model) => {
      expect(isKimiLeafProvider({ providerName: "opencode-go", model })).toBe(
        true,
      );
      expect(detectModelFamily({ providerName: "opencode-go", model })).toBe(
        "kimi",
      );
    },
  );
});

describe("detectModelFamily", () => {
  test.each<[ProviderRow, ReturnType<typeof detectModelFamily>]>([
    [{ providerName: "xai/default", model: "grok-4.5" }, "grok"],
    [{ providerName: "xai/default", model: "grok-4.6" }, "grok"],
    [{ providerName: "xai/default", model: "grok-4.7" }, "grok"],
    [{ providerName: "moonshot", model: "kimi-k2" }, "kimi"],
    [{ providerName: "opencode-go", model: "kimi-k3" }, "kimi"],
    [{ providerName: "anthropic", model: "claude-sonnet-4" }, "claude"],
    [{ providerName: "openai-compat", model: "claude-opus-4-6" }, "claude"],
    [{ providerName: "openai", model: "gpt-5.6" }, "gpt"],
    [{ providerName: "unknown-provider", model: "unknown-model" }, "default"],
  ])("resolves %j -> %s", (row, expected) => {
    expect(detectModelFamily(row)).toBe(expected);
  });
});

describe("isClaudeLeafProvider", () => {
  test.each<[ProviderRow, boolean]>([
    [{ providerName: "anthropic" }, true],
    [{ providerName: "ANTHROPIC" }, true],
    [{ providerName: "openai-compat", model: "claude-sonnet-4" }, true],
    [{ providerName: "xai/default", model: "grok-4.5" }, false],
    [{ providerName: "openai", model: "gpt-5.6" }, false],
    [{ providerName: "codex", model: "gpt-5.1" }, false],
    [{ providerName: "moonshot", model: "kimi-k2" }, false],
    [
      {
        providerName: "opencode-go/abklabs",
        model: "muse-spark-1.3-contributor",
      },
      false,
    ],
  ])("matches %j -> %s", (row, expected) => {
    expect(isClaudeLeafProvider(row)).toBe(expected);
  });
});

describe("isGptProvider (CL-8310)", () => {
  test.each<[ProviderRow, boolean]>([
    [{ providerName: "codex/default" }, true],
    [{ providerName: "codex/work" }, true],
    [{ providerName: "codex-responses" }, true],
    [{ providerName: "codex" }, true],
    [{ providerName: "openai", model: "gpt-5.5" }, true],
    [{ providerName: "opencode-go", model: "gpt-5.1" }, true],
    [{ providerName: "openai-compat", model: "gpt-5.6-luna" }, true],
    [{ providerName: "xai/default", model: "grok-4.6" }, false],
    [{ providerName: "moonshot", model: "kimi-k2" }, false],
    [
      {
        providerName: "opencode-go",
        model: "muse-spark-1.3-contributor",
      },
      false,
    ],
    [{ providerName: "anthropic", model: "claude-sonnet-4" }, false],
    [{ providerName: "anthropic" }, false],
  ])("matches %j -> %s", (row, expected) => {
    expect(isGptProvider(row)).toBe(expected);
  });

  test("covers every in-tree codex catalog model without naming cells", () => {
    // No terra/sol/astra special-casing: every served codex id resolves via
    // the generic codex-provider / gpt-* match, so future cells ride along.
    for (const model of CODEX_DEFAULT_MODELS) {
      expect(isGptProvider({ providerName: "codex/default", model })).toBe(
        true,
      );
      expect(detectModelFamily({ providerName: "codex/default", model })).toBe(
        "gpt",
      );
    }
  });
});
