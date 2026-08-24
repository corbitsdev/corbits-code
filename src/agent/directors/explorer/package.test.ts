import { describe, expect, test } from "bun:test";
import { explorerPackage } from "./package.js";

describe("explorerPackage", () => {
  test("id matches directory", () => {
    expect(explorerPackage.id).toBe("explorer");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(explorerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(explorerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(explorerPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(explorerPackage.systemPrompt).toContain(
      "naming the right director: builder, counsel, critic, greybeard, intern",
    );
  });

  test("systemPrompt has finish bias against re-reading the same paths", () => {
    expect(explorerPackage.systemPrompt).toMatch(/FINISH BIAS/i);
    expect(explorerPackage.systemPrompt).toMatch(/re-reading the same paths/i);
    expect(explorerPackage.systemPrompt).toMatch(
      /Expand Findings, change approach, or write the final report/i,
    );
  });

  test("systemPrompt requires scannable Findings shape", () => {
    expect(explorerPackage.systemPrompt).toMatch(/FINDINGS SHAPE/i);
    expect(explorerPackage.systemPrompt).toMatch(/scannable map/i);
    expect(explorerPackage.systemPrompt).toMatch(/key paths/i);
    expect(explorerPackage.systemPrompt).toMatch(/symbols/i);
    expect(explorerPackage.systemPrompt).toMatch(/call flow/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(explorerPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow mounts product writes (lane: no product edits)", () => {
    const allow = explorerPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("grep");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is explore", () => {
    expect(explorerPackage.modelRole).toBe("explore");
  });
});
