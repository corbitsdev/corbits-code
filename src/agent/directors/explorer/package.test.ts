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
    expect(explorerPackage.systemPrompt).toMatch(/map and read/i);
  });

  test("systemPrompt identity is Explorer / ExplorerDirector (not job-title language)", () => {
    const p = explorerPackage.systemPrompt;
    expect(p).toMatch(/ExplorerDirector \(Explorer\)/);
    expect(p).toMatch(/explore lane only/i);
    expect(p).not.toMatch(/ExploreDirector(?! \(Explorer\))/);
    expect(p).not.toMatch(/explore director/i);
  });

  test("systemPrompt teaches success_criteria-driven mapping", () => {
    const p = explorerPackage.systemPrompt;
    expect(p).toContain("Map against the brief");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/scannable map/i);
    expect(p).toMatch(/Paths read/i);
    expect(p).toContain("Blockers");
  });

  test("systemPrompt is explore lane only (map/read; no implement / spawn / fleet discovery)", () => {
    const p = explorerPackage.systemPrompt;
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/Blinders on/i);
    expect(p).toMatch(/fleet/i);
    expect(p).toMatch(/report Blockers/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = explorerPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/grep\/search_files\/lsp/i);
    expect(p).not.toMatch(/Shell find/i);
  });

  test("systemPrompt has DONE GATE for success_criteria", () => {
    const prompt = explorerPackage.systemPrompt;
    expect(prompt).toContain("DONE GATE");
    expect(prompt).toContain("success_criteria");
    expect(prompt).toMatch(/[Ss]top when/);
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
