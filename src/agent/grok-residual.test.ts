import { describe, expect, it } from "bun:test";
import { grokRow } from "../../packages/prompt-variance/src/rows.js";
import {
  GROK_PROMPT_RESIDUAL,
  resolveModelFamilyPolicy,
} from "./model-family-policy.js";
import { buildSubAgentSystemPrompt } from "./prompts.js";
import { shouldApplyGrokAntiThrash } from "../subagent/provider-family.js";

describe("grok single residual (CL-10674 P2)", () => {
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

  it("merges the former double append into ONE block, each idea once", () => {
    // The tool-budget and finish-bias residuals used to ship as two blocks.
    // The merged row stays one block: one heading, no bullet twice.
    expect(
      grokRow.residual.startsWith("Tool budget (xAI / Grok worker):"),
    ).toBe(true);
    expect(grokRow.residual).toBe(GROK_PROMPT_RESIDUAL);
    for (const line of [
      "- Batch independent tool calls into a single turn.",
      "- Never re-issue a tool call whose result you already have.",
      "- If the next call would only re-open paths you already read, write the report instead.",
      "- When the dispatch brief's done-definition is met, write the report envelope instead of making one more search or micro-edit.",
    ]) {
      const occurrences = grokRow.residual.split(line).length - 1;
      expect(occurrences).toBe(1);
    }
    // One heading only: the old "Finish bias (xAI / Grok worker):" heading is
    // merged away.
    expect(grokRow.residual).not.toContain("Finish bias (xAI / Grok worker):");
    expect(grokRow.residual.split("Tool budget").length - 1).toBe(1);
  });

  it("the assembled grok leaf prompt carries the block exactly once", () => {
    const policy = resolveModelFamilyPolicy({
      providerName: "xai/default",
      model: "grok-4.6",
      orchestrator: false,
    });
    const prompt = buildSubAgentSystemPrompt(["card"], undefined, undefined, {
      orchestrator: false,
      toolNames: ["read"],
      promptResidual: policy.promptResidual,
    });
    const occurrences =
      prompt.split("Tool budget (xAI / Grok worker):").length - 1;
    expect(occurrences).toBe(1);
    expect(prompt).not.toContain("Finish bias (xAI / Grok worker):");
  });
});
