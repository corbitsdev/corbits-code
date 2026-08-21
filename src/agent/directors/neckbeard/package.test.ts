import { describe, expect, test } from "bun:test";
import { neckbeardPackage } from "./package.js";

describe("neckbeardPackage", () => {
  test("id matches directory", () => {
    expect(neckbeardPackage.id).toBe("neckbeard");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(neckbeardPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(neckbeardPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(neckbeardPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt is hygiene with receipts, not a patcher", () => {
    expect(neckbeardPackage.systemPrompt).toMatch(/hygiene/i);
    expect(neckbeardPackage.systemPrompt).toMatch(/Never patch/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(neckbeardPackage.spawn.maySpawn).toBe(false);
  });

  test("denies product write tools", () => {
    const allow = neckbeardPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("report requires envelope sections", () => {
    for (const section of ["Summary", "Findings", "Blockers", "Paths"]) {
      expect(neckbeardPackage.report.requiredSections).toContain(section);
    }
  });

  test("modelRole is review", () => {
    expect(neckbeardPackage.modelRole).toBe("review");
  });

  test("required style and philosophy", () => {
    expect(neckbeardPackage.requiredSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match neckbeard lane", () => {
    expect(neckbeardPackage.primaryIntent).toBe("Adversarial pedantic review; never fix");
    expect(neckbeardPackage.outOfLane).toContain("applying fixes");
    expect(neckbeardPackage.outOfLane).toContain("product implementation");
    expect(neckbeardPackage.outOfLane).toContain("architecture ownership");
  });

  test("nudge maxTurns is 40", () => {
    expect(neckbeardPackage.nudge?.maxTurns).toBe(40);
  });
});
