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
    expect(explorePackage.systemPrompt).toMatch(/map and read/i);
  });

  test("systemPrompt identity is Explorer / ExplorerDirector (not job-title language)", () => {
    const p = explorePackage.systemPrompt;
    expect(p).toMatch(/ExplorerDirector \(Explorer\)/);
    expect(p).toMatch(/explore lane only/i);
    expect(p).not.toMatch(/ExploreDirector(?! \(Explorer\))/);
    expect(p).not.toMatch(/explore director/i);
  });

  test("systemPrompt teaches success_criteria-driven mapping", () => {
    const p = explorePackage.systemPrompt;
    expect(p).toContain("Map against the brief");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/scannable map/i);
    expect(p).toMatch(/Paths read/i);
    expect(p).toContain("Blockers");
  });

  test("systemPrompt is explore lane only (map/read; no implement / spawn / fleet discovery)", () => {
    const p = explorePackage.systemPrompt;
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/Blinders on/i);
    expect(p).toMatch(/fleet/i);
    expect(p).toMatch(/report Blockers/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = explorePackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/grep\/search_files\/lsp/i);
    expect(p).not.toMatch(/Shell find/i);
  });

  test("systemPrompt has DONE GATE for success_criteria", () => {
    const prompt = explorePackage.systemPrompt;
    expect(prompt).toContain("DONE GATE");
    expect(prompt).toContain("success_criteria");
    expect(prompt).toMatch(/[Ss]top when/);
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

  test("tools.allow is read-only (no product writes)", () => {
    const allow = explorePackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("grep");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is explore", () => {
    expect(explorePackage.modelRole).toBe("explore");
  });
});
