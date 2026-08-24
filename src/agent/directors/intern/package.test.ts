import { describe, expect, test } from "bun:test";

import { internPackage } from "./package.js";

describe("internPackage", () => {
  test("id matches directory", () => {
    expect(internPackage.id).toBe("intern");
  });

  test("systemPrompt is real (not placeholder)", () => {
    expect(internPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(internPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
    expect(internPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(internPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is shell-first with path writes", () => {
    const allow = internPackage.tools?.allow ?? [];
    expect(allow).toContain("run_shell");
    expect(allow).toContain("read_file");
    expect(allow).toContain("list_dir");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
    for (const name of ["grep", "search_files", "task", "apply_patch"]) {
      expect(allow).not.toContain(name);
    }
  });

  test("modelRole is implement", () => {
    expect(internPackage.modelRole).toBe("implement");
  });

  test("optionalSkills is empty by default", () => {
    expect(internPackage.optionalSkills).toEqual([]);
  });

  test("primaryIntent and description", () => {
    expect(internPackage.primaryIntent).toContain("Mechanical shell/commands only");
    expect(internPackage.description).toBe("Mechanical intern leaf");
  });
});
