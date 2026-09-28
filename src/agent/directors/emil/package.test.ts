import { describe, expect, test } from "bun:test";
import { emilPackage } from "./package.js";

describe("emilPackage", () => {
  test("systemPrompt carries no retired law library", () => {
    const p = emilPackage.systemPrompt;
    expect(p).not.toMatch(/Second-System/);
    expect(p).not.toMatch(/Zawinski/);
    expect(p).not.toMatch(/SOLID/);
    expect(p).not.toMatch(/Boy Scout Rule/);
    expect(p).not.toMatch(/First Principles/);
    expect(p).not.toMatch(/Inversion/);
    expect(p).not.toMatch(/Gilb's Law/);
    expect(p).not.toMatch(/Principle of Least Astonishment/);
    expect(p).not.toMatch(/Testing Pyramid/);
    expect(p).not.toMatch(/Pesticide Paradox/);
    expect(p).not.toMatch(/Sturgeon/);
    expect(p).not.toMatch(/Technical Debt/);
    expect(p).not.toMatch(/Postel/);
    expect(p).not.toMatch(/Thinking & reasoning/i);
    expect(p).not.toMatch(/cross-reference/i);
    expect(p).not.toMatch(/tmp\/critique-tests/);
    expect(p).not.toMatch(/Quality Over Quantity/);
    expect(p).not.toMatch(/Don't Moralize/);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = emilPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are not mounted/i);
    expect(p).not.toMatch(/via run_shell/i);
    expect(p).not.toMatch(/Never spawn/);
  });

  test("tools.allow is read-only: no product writes", () => {
    const allow = emilPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("run_shell");
    expect(allow).toContain("skill_search");
    expect(allow).toContain("use_skill");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("optionalSkills declares brand-identity only", () => {
    expect(emilPackage.optionalSkills).toEqual(["brand-identity"]);
  });

  test("modelRole is review", () => {
    expect(emilPackage.modelRole).toBe("review");
  });

  test("description matches the narrowed tokens-only lane", () => {
    expect(emilPackage.description).toMatch(/Design engineering critique/i);
    expect(emilPackage.description).toMatch(/product decisions/i);
    expect(emilPackage.description).toMatch(/fix direction/i);
    expect(emilPackage.description).toMatch(/never fixes them/i);
  });

  test("primaryIntent and outOfLane match emil lane", () => {
    expect(emilPackage.primaryIntent).toBe(
      "Design-engineering critique with fix direction; never fix product code",
    );
    expect(emilPackage.outOfLane).toContain("shipping product code");
    expect(emilPackage.outOfLane).toContain("marketing content");
    expect(emilPackage.outOfLane).toContain(
      "applying product fixes or writing full implementations",
    );
    expect(emilPackage.outOfLane).toContain("visual-token ownership (draper)");
    expect(emilPackage.outOfLane).toContain("DESIGN.md ownership (rand)");
    expect(emilPackage.outOfLane).toContain(
      "correctness-severity ownership (critic)",
    );
    expect(emilPackage.outOfLane).toContain("architecture gate (greybeard)");
  });
});
