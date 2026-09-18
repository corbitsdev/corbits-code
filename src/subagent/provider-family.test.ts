import { describe, expect, test } from "bun:test";
import {
  detectModelFamily,
  isGptProvider,
  isKimiLeafProvider,
  isXaiGrokLeafProvider,
  shouldApplyGrokAntiThrash,
} from "./provider-family.js";
import { CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js";

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
      isXaiGrokLeafProvider({ providerName: "openai", model: "gpt-4.1" }),
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
  test("detects grok, kimi, and default", () => {
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
    ).toBe("default");
  });
});

describe("isGptProvider (CL-8310)", () => {
  test("matches codex OAuth provider names", () => {
    expect(isGptProvider({ providerName: "codex/default" })).toBe(true);
    expect(isGptProvider({ providerName: "codex/work" })).toBe(true);
  });

  test("matches codex adapter ids and bare codex names", () => {
    expect(isGptProvider({ providerName: "codex-responses" })).toBe(true);
    expect(isGptProvider({ providerName: "codex" })).toBe(true);
  });

  test("matches gpt-* model ids on any provider", () => {
    expect(isGptProvider({ providerName: "openai", model: "gpt-5.5" })).toBe(
      true,
    );
    expect(
      isGptProvider({ providerName: "opencode-go", model: "gpt-5.1" }),
    ).toBe(true);
    expect(
      isGptProvider({ providerName: "openai-compat", model: "gpt-5.6-luna" }),
    ).toBe(true);
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

  test("rejects grok, kimi, muse, and claude", () => {
    expect(
      isGptProvider({ providerName: "xai/default", model: "grok-4.6" }),
    ).toBe(false);
    expect(isGptProvider({ providerName: "moonshot", model: "kimi-k2" })).toBe(
      false,
    );
    expect(
      isGptProvider({
        providerName: "opencode-go",
        model: "muse-spark-1.3-contributor",
      }),
    ).toBe(false);
    expect(
      isGptProvider({
        providerName: "anthropic",
        model: "claude-sonnet-4",
      }),
    ).toBe(false);
    expect(isGptProvider({ providerName: "anthropic" })).toBe(false);
  });
});
