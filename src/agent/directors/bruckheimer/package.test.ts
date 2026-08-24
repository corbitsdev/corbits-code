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
    expect(bruckheimerPackage.systemPrompt).toContain(
      "Route those via Blockers to build, greybeard, critique, or skywalker",
    );
  });

  test("spawn.maySpawn is false", () => {
    expect(bruckheimerPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools", () => {
    const allow = bruckheimerPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
  });

  test("modelRole is docs", () => {
    expect(bruckheimerPackage.modelRole).toBe("docs");
  });

  test("primaryIntent and outOfLane match discovery lane", () => {
    expect(bruckheimerPackage.primaryIntent).toMatch(/product discovery/i);
    expect(bruckheimerPackage.outOfLane).toContain("shipping product code");
    expect(bruckheimerPackage.outOfLane).toContain("architecture gates");
  });
});
