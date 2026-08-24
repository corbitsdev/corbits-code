import { describe, expect, test } from "bun:test";
import { explorePackage } from "./package.js";

describe("explorePackage", () => {
  test("id matches directory", () => {
    expect(explorePackage.id).toBe("explore");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(explorePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(explorePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(explorePackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(explorePackage.systemPrompt).toContain(
      "naming the right director: build, plan, critique, greybeard, intern",
    );
  });

  test("systemPrompt has finish bias against re-reading the same paths", () => {
    expect(explorePackage.systemPrompt).toMatch(/FINISH BIAS/i);
    expect(explorePackage.systemPrompt).toMatch(/re-reading the same paths/i);
    expect(explorePackage.systemPrompt).toMatch(
      /Expand Findings, change approach, or write the final report/i,
    );
  });

  test("systemPrompt requires scannable Findings shape", () => {
    expect(explorePackage.systemPrompt).toMatch(/FINDINGS SHAPE/i);
    expect(explorePackage.systemPrompt).toMatch(/scannable map/i);
    expect(explorePackage.systemPrompt).toMatch(/key paths/i);
    expect(explorePackage.systemPrompt).toMatch(/symbols/i);
    expect(explorePackage.systemPrompt).toMatch(/call flow/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(explorePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow mounts product writes (lane: no product edits)", () => {
    const allow = explorePackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("grep");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is explore", () => {
    expect(explorePackage.modelRole).toBe("explore");
  });
});
