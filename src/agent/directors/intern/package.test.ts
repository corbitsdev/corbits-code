import { describe, expect, test } from "bun:test";

import { internPackage, type AgentPackage } from "@corbits/agent-intern";
import { DIRECTOR_REGISTRY } from "../registry.js";
import { INTERN_TOOLS } from "../tool-sets.js";

describe("internPackage", () => {
  test("workspace package is an AgentPackage used by the registry", () => {
    const pkg: AgentPackage = internPackage;
    expect(pkg.id).toBe("intern");
    expect(DIRECTOR_REGISTRY.intern).toBe(internPackage);
    expect([...(pkg.tools?.allow ?? [])]).toEqual([...INTERN_TOOLS]);
  });

  test("systemPrompt is mechanical executor (gaas intern port)", () => {
    const p = internPackage.systemPrompt;
    expect(p).toMatch(/intern assistant/);
    expect(p).toMatch(/execute clear (mechanical )?instructions/i);
    expect(p).toMatch(/STOP/i);
    expect(p).toMatch(/ask_director/);
    // Envelope shape is scaffold-owned: do not re-specify it in the body.
    expect(p).not.toMatch(/Corbits report envelope/);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Paths/);
    // Role forbids debugging; body states the ban explicitly
    expect(p).toMatch(/You do NOT:[\s\S]*Debug failures/);
    // Writes and background-shell policy live on the mount, not extra essays.
    expect(p).not.toMatch(/write_file/);
    expect(p).not.toMatch(/Background shells are forbidden/);
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
