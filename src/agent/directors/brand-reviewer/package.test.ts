import { describe, expect, test } from "bun:test";
import { brandReviewerPackage } from "./package.js";

describe("brandReviewerPackage", () => {
  test("id matches directory", () => {
    expect(brandReviewerPackage.id).toBe("brand-reviewer");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(brandReviewerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(brandReviewerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(brandReviewerPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(brandReviewerPackage.systemPrompt).toContain("name build");
    expect(brandReviewerPackage.systemPrompt).not.toContain("name implement");
  });

  test("spawn.maySpawn is false", () => {
    expect(brandReviewerPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools", () => {
    const allow = brandReviewerPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
  });

  test("systemPrompt mentions DESIGN.md", () => {
    expect(brandReviewerPackage.systemPrompt).toMatch(/DESIGN\.md/);
    expect(brandReviewerPackage.systemPrompt).not.toMatch(/authz/i);
  });

  test("modelRole is docs", () => {
    expect(brandReviewerPackage.modelRole).toBe("docs");
  });

  test("primaryIntent and outOfLane match brand-reviewer lane", () => {
    expect(brandReviewerPackage.primaryIntent).toBe("Own DESIGN.md create/use + brand gate");
    expect(brandReviewerPackage.outOfLane).toContain("arbitrary product code outside DESIGN.md");
  });
});
