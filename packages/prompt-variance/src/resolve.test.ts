import { describe, expect, test } from "bun:test";
import { resolvePromptVariance } from "./resolve.js";
import { grokRow } from "./rows.js";

describe("resolvePromptVariance", () => {
  test("resolves each family to its row", () => {
    expect(resolvePromptVariance({ family: "default" }).id).toBe("default");
    expect(resolvePromptVariance({ family: "muse" }).id).toBe("muse");
    expect(resolvePromptVariance({ family: "grok" }).id).toBe("grok");
    expect(resolvePromptVariance({ family: "claude" }).id).toBe("claude");
    expect(resolvePromptVariance({ family: "gpt" }).id).toBe("gpt");
  });

  test("grok keeps its finish-bias residual on leaves", () => {
    const row = resolvePromptVariance({ family: "grok", orchestrator: false });
    expect(row.residual).toBe(grokRow.residual);
  });

  test("grok on orchestrators falls back to the default row", () => {
    const row = resolvePromptVariance({ family: "grok", orchestrator: true });
    expect(row.id).toBe("default");
    expect(row.residual).toBe("");
  });

  test("claude keeps its task_guidance block on leaves, not orchestrators", () => {
    expect(
      resolvePromptVariance({ family: "claude", orchestrator: false }).residual,
    ).toContain("<task_guidance>");
    const orch = resolvePromptVariance({
      family: "claude",
      orchestrator: true,
    });
    expect(orch.id).toBe("default");
    expect(orch.residual).toBe("");
  });

  test("muse keeps its residual on leaves and orchestrators alike", () => {
    expect(
      resolvePromptVariance({ family: "muse", orchestrator: false }).residual,
    ).not.toBe("");
    expect(
      resolvePromptVariance({ family: "muse", orchestrator: true }).residual,
    ).not.toBe("");
  });

  test("gpt keeps its narrate-before-tools nudge on leaves and orchestrators alike", () => {
    expect(
      resolvePromptVariance({ family: "gpt", orchestrator: false }).residual,
    ).toContain("Narrate before tools");
    expect(
      resolvePromptVariance({ family: "gpt", orchestrator: true }).residual,
    ).toContain("Narrate before tools");
  });
});
