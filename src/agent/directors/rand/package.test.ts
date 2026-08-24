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

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(randPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(randPackage.systemPrompt).toContain("name builder");
    expect(randPackage.systemPrompt).not.toContain("name implement");
  });

  test("spawn.maySpawn is false", () => {
    expect(randPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools", () => {
    const allow = randPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
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
