import { describe, expect, test } from "bun:test";

import { internPackage } from "./package.js";

describe("internPackage", () => {
  test("systemPrompt is mechanical executor (gaas intern port)", () => {
    const p = internPackage.systemPrompt;
    expect(p).toMatch(/execute clear (mechanical )?instructions/i);
    expect(p).toMatch(/STOP/i);
    expect(p).toMatch(/Blockers/i);
    // Envelope shape is scaffold-owned: point at it, do not re-specify it.
    expect(p).toMatch(/Corbits report envelope/);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Paths/);
    expect(p).toMatch(/run_shell/);
    // Role forbids debugging; body states the ban explicitly
    expect(p).toMatch(/You do NOT:[\s\S]*Debug failures/);
  });

  test("fail-closes without shell_collect rather than pinning prompt copy", () => {
    const allow = internPackage.tools?.allow ?? [];
    expect(allow).not.toContain("shell_collect");
  });

  test("tools.allow has path writes with a narrow deny set", () => {
    const allow = internPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("list_dir");
    expect(allow).not.toContain("shell_collect");
    for (const name of [
      "grep",
      "search_files",
      "spawn_agent",
      "wait_agents",
      "apply_patch",
    ]) {
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
    expect(internPackage.primaryIntent).toMatch(
      /mechanical|exact|zero judgment/i,
    );
    expect(internPackage.description).toBe("Mechanical intern");
  });

  test("outOfLane bans debugging and exploration", () => {
    const lane = internPackage.outOfLane.join(" ");
    expect(lane).toMatch(/debug/i);
    expect(lane).toMatch(/explor/i);
    expect(lane).toMatch(/spawn/i);
  });
});
