import { describe, expect, test } from "bun:test";
import { applyRowOverride, resolvePromptVariance } from "./resolve.js";
import { grokRow } from "./rows.js";

// CL-8269 RED: the resolver does not exist yet — every test below fails
// until the GREEN lands packages/prompt-variance.

describe("resolvePromptVariance", () => {
  test("resolves each family to its row", () => {
    expect(resolvePromptVariance({ family: "default" }).id).toBe("default");
    expect(resolvePromptVariance({ family: "muse" }).id).toBe("muse");
    expect(resolvePromptVariance({ family: "grok" }).id).toBe("grok");
  });

  test("grok keeps its finish-bias residual and skill_search deny on leaves", () => {
    const row = resolvePromptVariance({ family: "grok", orchestrator: false });
    expect(row.residual).toBe(grokRow.residual);
    expect(row.advertisedToolDeny).toContain("skill_search");
  });

  test("grok on orchestrators falls back to the default shape", () => {
    const row = resolvePromptVariance({ family: "grok", orchestrator: true });
    expect(row.residual).toBe("");
    expect([...row.advertisedToolDeny]).toEqual([]);
  });

  test("muse keeps its residual on leaves and orchestrators alike", () => {
    expect(
      resolvePromptVariance({ family: "muse", orchestrator: false }).residual,
    ).not.toBe("");
    expect(
      resolvePromptVariance({ family: "muse", orchestrator: true }).residual,
    ).not.toBe("");
  });

  test("applies per-model-id overrides from the row", () => {
    const row = applyRowOverride(
      {
        ...grokRow,
        overrides: {
          "grok-4-special": { advertisedToolDeny: [] },
        },
      },
      "GROK-4-SPECIAL",
    );
    expect([...row.advertisedToolDeny]).toEqual([]);
    expect(row.residual).toBe(grokRow.residual);
  });

  test("an unknown model id resolves to the base row", () => {
    const row = resolvePromptVariance({
      family: "grok",
      orchestrator: false,
      model: "grok-9-unknown",
    });
    expect(row.residual).toBe(grokRow.residual);
    expect([...row.advertisedToolDeny]).toEqual(["skill_search"]);
  });
});
