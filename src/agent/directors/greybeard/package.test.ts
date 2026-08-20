import { describe, expect, test } from "bun:test";
import { greybeardPackage } from "./package.js";

describe("greybeardPackage", () => {
  test("id matches directory", () => {
    expect(greybeardPackage.id).toBe("greybeard");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(greybeardPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(greybeardPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT and GreybeardDirector", () => {
    expect(greybeardPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(greybeardPackage.systemPrompt).toContain("GreybeardDirector");
  });

  test("spawn.maySpawn is true with limited allowlist", () => {
    expect(greybeardPackage.spawn.maySpawn).toBe(true);
    expect(greybeardPackage.spawn.allowlist).toEqual(["intern", "explore", "critique"]);
  });

  test("allowlist is only intern, explore, critique", () => {
    const allow = greybeardPackage.spawn.allowlist ?? [];
    expect(allow).toHaveLength(3);
    expect(allow).toContain("intern");
    expect(allow).toContain("explore");
    expect(allow).toContain("critique");
    expect(allow).not.toContain("implement");
    expect(allow).not.toContain("skywalker");
    expect(allow).not.toContain("plan");
  });

  test("systemPrompt forbids parallel diagnostic fleets", () => {
    expect(greybeardPackage.systemPrompt).toMatch(/do the review yourself/i);
    expect(greybeardPackage.systemPrompt).toMatch(/spawn at most one intern/i);
    expect(greybeardPackage.systemPrompt).toMatch(/never spawn a parallel diagnostic fleet/i);
  });

  test("tools.allow is orchestrator surface without product writes", () => {
    const allow = greybeardPackage.tools?.allow ?? [];
    expect(allow).toContain("task");
    expect(allow).toContain("search_agents");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("report requires envelope sections", () => {
    for (const section of ["Summary", "Findings", "Blockers", "Paths"]) {
      expect(greybeardPackage.report.requiredSections).toContain(section);
    }
  });

  test("modelRole is review", () => {
    expect(greybeardPackage.modelRole).toBe("review");
  });

  test("optionalSkills order", () => {
    expect(greybeardPackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match greybeard lane", () => {
    expect(greybeardPackage.primaryIntent).toBe("Architecture review; limited spawn");
    expect(greybeardPackage.outOfLane).toContain("shipping product code");
    expect(greybeardPackage.outOfLane).toContain("pedantic style-only nitpicking");
  });

  test("nudge maxTurns is 50", () => {
    expect(greybeardPackage.nudge?.maxTurns).toBe(50);
  });
});
