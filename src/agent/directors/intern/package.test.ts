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

  test("systemPrompt is mechanical executor (gaas intern port)", () => {
    const p = internPackage.systemPrompt;
    expect(p).toMatch(/execute clear (mechanical )?instructions/i);
    expect(p).toMatch(/STOP/i);
    expect(p).toMatch(/Blockers/i);
    expect(p).toMatch(/## Summary/);
    expect(p).toMatch(/## Findings/);
    expect(p).toMatch(/## Paths/);
    expect(p).toMatch(/run_shell/);
    // Role forbids debugging; body states the ban explicitly
    expect(p).toMatch(/You do NOT:[\s\S]*Debug failures/);
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
    for (const name of ["grep", "search_files", "spawn_agent", "wait_agents", "apply_patch"]) {
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
    expect(internPackage.primaryIntent).toMatch(/mechanical|exact|zero judgment/i);
    expect(internPackage.description).toBe("Mechanical intern");
  });

  test("outOfLane bans debugging and exploration", () => {
    const lane = internPackage.outOfLane.join(" ");
    expect(lane).toMatch(/debug/i);
    expect(lane).toMatch(/explor/i);
    expect(lane).toMatch(/spawn/i);
  });
});
