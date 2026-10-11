import { describe, expect, test } from "bun:test";
import {
  detectModelFamily,
  isAstraLeafProvider,
  isClaudeLeafProvider,
  isDeepSeekLeafProvider,
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
    [{ providerName: "openai-compat", model: "deepseek-v4-pro" }, "deepseek"],
    [{ providerName: "opencode-go", model: "deepseek-v4-flash" }, "deepseek"],
    [
      { providerName: "openai-compat", model: "deepseek-v4-flash-vision-exp" },
      "deepseek",
    ],
    [
      { providerName: "openai-compat", model: "deepseek-ai/deepseek-v3" },
      "deepseek",
    ],
    [{ providerName: "openai-compat", model: "deepseek-coder" }, "deepseek"],
    [{ providerName: "openai-compat", model: "unknown-model" }, "default"],
  ])("resolves %j -> %s", (row, expected) => {
    expect(detectModelFamily(row)).toBe(expected);
  });
});

describe("isDeepSeekLeafProvider", () => {
  test.each<[ProviderRow, boolean]>([
    [{ providerName: "openai-compat", model: "deepseek-v4-pro" }, true],
    [{ providerName: "openai-compat", model: "deepseek-v4-flash" }, true],
    [
      { providerName: "openai-compat", model: "deepseek-v4-flash-vision-exp" },
      true,
    ],
    [{ providerName: "openai-compat", model: "DEEPSEEK-V4-PRO" }, true],
    [{ providerName: "openai-compat", model: "deepseek-v3" }, true],
    [
      { providerName: "openai-compat", model: "deepseek-ai/deepseek-chat" },
      true,
    ],
    [{ providerName: "xai/default", model: "grok-4.6" }, false],
    [{ providerName: "openai", model: "gpt-5.6" }, false],
    [{ providerName: "openai-compat" }, false],
  ])("matches %j -> %s", (row, expected) => {
    expect(isDeepSeekLeafProvider(row)).toBe(expected);
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
        providerName: "opencode-go/acme",
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

  test("astra branches to its own family; other cells ride the generic gpt match", () => {
    // Astra reverses the no-special-casing rule only: the
    // gpt-6-astra cell doom-loops, so it resolves to the astra family while
    // sol/terra/luna and generic gpt ids keep the generic gpt match.
    for (const model of CODEX_DEFAULT_MODELS) {
      expect(isGptProvider({ providerName: "codex/default", model })).toBe(
        true,
      );
      const family = detectModelFamily({
        providerName: "codex/default",
        model,
      });
      if (model.toLowerCase().startsWith("gpt-6-astra")) {
        expect(family).toBe("astra");
      } else {
        expect(family).toBe("gpt");
      }
    }
  });
});

describe("isAstraLeafProvider (CL-9027)", () => {
  test("matches the served gpt-6-astra cell id on any provider", () => {
    expect(
      isAstraLeafProvider({
        providerName: "codex/default",
        model: "gpt-6-astra",
      }),
    ).toBe(true);
    expect(
      isAstraLeafProvider({
        providerName: "openai-compat",
        model: "GPT-6-ASTRA",
      }),
    ).toBe(true);
    expect(
      detectModelFamily({
        providerName: "codex/default",
        model: "gpt-6-astra",
      }),
    ).toBe("astra");
  });

  test("rejects sol, generic gpt, and other families", () => {
    for (const input of [
      { providerName: "codex/default", model: "gpt-5.6-sol" },
      { providerName: "codex/default", model: "gpt-5.6-terra" },
      { providerName: "codex/default", model: "gpt-5.6-luna" },
      { providerName: "openai", model: "gpt-5.6" },
      { providerName: "codex", model: "gpt-5.1" },
      { providerName: "xai/default", model: "grok-4.6" },
      { providerName: "anthropic", model: "claude-sonnet-4" },
    ] as const) {
      expect(isAstraLeafProvider(input)).toBe(false);
    }
    expect(
      detectModelFamily({
        providerName: "codex/default",
        model: "gpt-5.6-sol",
      }),
    ).toBe("gpt");
    expect(
      detectModelFamily({ providerName: "openai", model: "gpt-5.6" }),
    ).toBe("gpt");
  });
});
