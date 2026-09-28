import { describe, expect, it } from "bun:test";
import { GROK_PROMPT_RESIDUAL } from "./model-family-policy.js";
import { buildGrokLeafAntiThrashNote } from "./prompts.js";
import { shouldApplyGrokAntiThrash } from "../subagent/provider-family.js";

describe("grok ceremony merge (CL-8296)", () => {
  it("is grok-only: the finish-bias gate fires for grok leaves alone", () => {
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "xai/default",
        model: "grok-4.6",
        orchestrator: false,
      }),
    ).toBe(true);
    for (const input of [
      { providerName: "anthropic", model: "claude-sonnet-4" },
      { providerName: "moonshot", model: "kimi-k2" },
      { providerName: "opencode-go", model: "muse-spark-1.3-contributor" },
      { providerName: "openai", model: "gpt-5.6" },
    ] as const) {
      expect(shouldApplyGrokAntiThrash({ ...input, orchestrator: false })).toBe(
        false,
      );
    }
    expect(
      shouldApplyGrokAntiThrash({
        providerName: "xai/default",
        model: "grok-4.6",
        orchestrator: true,
      }),
    ).toBe(false);
  });

  it("buildGrokLeafAntiThrashNote is the same single residual (one source of truth)", () => {
    expect(buildGrokLeafAntiThrashNote()).toBe(GROK_PROMPT_RESIDUAL);
  });
});
