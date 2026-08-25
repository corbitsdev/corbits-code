import { describe, expect, test } from "bun:test";
import { testsmithPackage } from "./package.js";

describe("testsmithPackage", () => {
  test("id matches directory / registry id", () => {
    expect(testsmithPackage.id).toBe("testsmith");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(testsmithPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(testsmithPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt identity is Testsmith / TestsmithDirector", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).toMatch(/TestsmithDirector \(Testsmith\)/);
    expect(p).toContain("PRIMARY INTENT");
    expect(p).toMatch(/permanent test/i);
  });

  test("systemPrompt teaches design-in-report workflow and case template", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).toMatch(/Design-in-report workflow/i);
    expect(p).toMatch(/Blinders on|BLINDERS ON/i);
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/Case template/i);
    expect(p).toMatch(/\*\*Setup\*\*/);
    expect(p).toMatch(/\*\*Action\*\*/);
    expect(p).toMatch(/\*\*Expect\*\*/);
    expect(p).toMatch(/what not to test/i);
    expect(p).toMatch(/unit \| integration \| e2e/);
  });

  test("systemPrompt teaches risk prioritization", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).toMatch(/Risk prioritization/i);
    expect(p).toMatch(/Cover first/i);
    expect(p).toMatch(/Defer or omit/i);
  });

  test("systemPrompt is design lane only (not Tester / Builder / orchestrator)", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).toMatch(/Do not become Builder/i);
    expect(p).toMatch(/that is Tester/i);
    expect(p).toMatch(/do not use them/i);
    expect(p).toMatch(/fleet orchestration/i);
    expect(p).toMatch(/DONE GATE/i);
    expect(p).toMatch(/Hand off/i);
  });

  test("systemPrompt states Corbits report shape", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).toContain("## Summary");
    expect(p).toContain("## Findings");
    expect(p).toContain("## Blockers");
    expect(p).toContain("## Paths");
    expect(p).toMatch(/Corbits report shape/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
  });

  test("systemPrompt is not a gaasbot twin", () => {
    const p = testsmithPackage.systemPrompt;
    expect(p).not.toMatch(/Gaasbot/i);
    expect(p).not.toMatch(/risk counsel/i);
    expect(p).not.toMatch(/ship-with-note/i);
    expect(p).not.toMatch(/filed-for-later/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(testsmithPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow mounts product writes (lane: design only)", () => {
    const allow = testsmithPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is test", () => {
    expect(testsmithPackage.modelRole).toBe("test");
  });

  test("primaryIntent is permanent-design and not primary verifier", () => {
    expect(testsmithPackage.primaryIntent).toMatch(/permanent test cases/i);
    expect(testsmithPackage.primaryIntent).toMatch(/not.*verifier|do not run as primary verifier/i);
  });

  test("outOfLane refuses product implement, verifier role, and landing tests", () => {
    const joined = testsmithPackage.outOfLane.join(" ");
    expect(joined).toMatch(/implement/i);
    expect(joined).toMatch(/verifier|tester/i);
    expect(joined).toMatch(/landing test/i);
  });
});
