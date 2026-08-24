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

  test("systemPrompt states PRIMARY INTENT for test design", () => {
    expect(testsmithPackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(testsmithPackage.systemPrompt).toMatch(/test strategy|test cases|design/i);
    expect(testsmithPackage.systemPrompt).toMatch(/do not implement|not implement/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(testsmithPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is read-only (no product writes)", () => {
    const allow = testsmithPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is test", () => {
    expect(testsmithPackage.modelRole).toBe("test");
  });

  test("primaryIntent is design-only and not primary verifier", () => {
    expect(testsmithPackage.primaryIntent).toMatch(/design/i);
    expect(testsmithPackage.primaryIntent).toMatch(/not.*verifier|do not run as primary verifier/i);
  });

  test("outOfLane refuses product implement and runtime verify role", () => {
    const joined = testsmithPackage.outOfLane.join(" ");
    expect(joined).toMatch(/implement/i);
    expect(joined).toMatch(/verifier|tester/i);
  });
});
