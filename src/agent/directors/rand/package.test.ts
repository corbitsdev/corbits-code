import { describe, expect, test } from "bun:test";
import { randPackage } from "./package.js";

describe("randPackage", () => {
  test("id matches directory", () => {
    expect(randPackage.id).toBe("rand");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(randPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(randPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt identity is Rand / RandDirector", () => {
    const p = randPackage.systemPrompt;
    expect(p).toMatch(/RandDirector \(Rand\)/);
    expect(p).toMatch(/brand contract lane|DESIGN\.md/i);
    expect(p).not.toMatch(/BrandReviewerDirector/);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(randPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(randPackage.systemPrompt).toContain("name builder");
    expect(randPackage.systemPrompt).not.toContain("name implement");
  });

  test("systemPrompt is blinders-on DESIGN.md gate (not draper / emil / builder / orchestrator)", () => {
    const p = randPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/not draper/i);
    expect(p).toMatch(/not emil/i);
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/do not patch code yourself/i);
  });

  test("systemPrompt teaches DESIGN.md gate workflow and verdicts", () => {
    const p = randPackage.systemPrompt;
    expect(p).toMatch(/Gate the work/i);
    expect(p).toMatch(/APPROVED/);
    expect(p).toMatch(/CHANGES REQUESTED/);
    expect(p).toMatch(/REJECTED/);
    expect(p).toMatch(/Expected vs Actual/i);
    expect(p).toMatch(/never silent product rewrites/i);
  });

  test("systemPrompt has DONE GATE and REPORT MAP for brand gate", () => {
    const p = randPackage.systemPrompt;
    expect(p).toContain("DONE GATE");
    expect(p).toContain("REPORT MAP");
    expect(p).toMatch(/pass \| fail \| blocked/);
    expect(p).toMatch(/gate verdict/i);
    expect(p).toMatch(/DESIGN\.md status/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = randPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Write tools are mounted with no path lock/i);
    expect(p).not.toMatch(/Never commit/i);
    expect(p).not.toMatch(/## Summary/);
  });

  test("spawn.maySpawn is false", () => {
    expect(randPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools", () => {
    const allow = randPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("systemPrompt mentions DESIGN.md", () => {
    expect(randPackage.systemPrompt).toMatch(/DESIGN\.md/);
    expect(randPackage.systemPrompt).not.toMatch(/authz/i);
  });

  test("modelRole is docs", () => {
    expect(randPackage.modelRole).toBe("docs");
  });

  test("primaryIntent and outOfLane match rand lane", () => {
    expect(randPackage.primaryIntent).toBe("Own DESIGN.md create/use + brand gate");
    expect(randPackage.outOfLane).toContain("arbitrary product code outside DESIGN.md");
  });
});
