import { describe, expect, test } from "bun:test";
import { bruckheimerPackage } from "./package.js";

describe("bruckheimerPackage", () => {
  test("id matches directory", () => {
    expect(bruckheimerPackage.id).toBe("bruckheimer");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(bruckheimerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(bruckheimerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(bruckheimerPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(bruckheimerPackage.spawn.maySpawn).toBe(false);
  });

  test("does not deny product write tools (discovery docs allowed)", () => {
    const deny = bruckheimerPackage.tools?.deny ?? [];
    expect(deny).not.toContain("write_file");
    expect(deny).not.toContain("edit_file");
    expect(deny).not.toContain("delete_file");
  });

  test("report requires envelope sections", () => {
    for (const section of ["Summary", "Findings", "Blockers", "Paths"]) {
      expect(bruckheimerPackage.report.requiredSections).toContain(section);
    }
  });

  test("modelRole is docs", () => {
    expect(bruckheimerPackage.modelRole).toBe("docs");
  });

  test("primaryIntent and outOfLane match discovery lane", () => {
    expect(bruckheimerPackage.primaryIntent).toMatch(/product discovery/i);
    expect(bruckheimerPackage.outOfLane).toContain("shipping product code");
    expect(bruckheimerPackage.outOfLane).toContain("architecture gates");
  });

  test("nudge maxTurns is 40", () => {
    expect(bruckheimerPackage.nudge?.maxTurns).toBe(40);
  });
});
