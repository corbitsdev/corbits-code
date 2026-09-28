import { describe, expect, test } from "bun:test";
import { migratorPackage } from "./package.js";

describe("migratorPackage", () => {
  test("tools.allow carries no fleet verbs and no path writes", () => {
    const allow = migratorPackage.tools?.allow ?? [];
    for (const verb of [
      "spawn_agent",
      "send_input",
      "list_agents",
      "search_agents",
      "wait_agents",
      "shell_collect",
    ] as const) {
      expect(allow).not.toContain(verb);
    }
    for (const tool of ["write_file", "edit_file", "delete_file"] as const) {
      expect(allow).not.toContain(tool);
    }
  });

  test("spawn has no allowlist (leaf)", () => {
    expect(migratorPackage.spawn.allowlist).toBeUndefined();
  });

  test("modelRole is plan", () => {
    expect(migratorPackage.modelRole).toBe("plan");
  });

  test("primaryIntent ships reversible migrations with evidence and rollback", () => {
    expect(migratorPackage.primaryIntent).toBe(
      "Ship reversible data migrations with dry-run evidence and a tested rollback path",
    );
  });

  test("outOfLane refuses renames, features, irreversible breaks, orchestration", () => {
    expect(migratorPackage.outOfLane).toEqual([
      "bulk code renames (ast-grep / refactor skill territory)",
      "product features",
      "API renames",
      "irreversible schema breaks without a rollback path",
      "orchestration or spawning workers",
    ]);
  });

  test("description names the reversible-migration lane", () => {
    expect(migratorPackage.description).toBe(
      "Reversible settings, config, and session-state migrations — forward path, rollback path, dry-run evidence",
    );
  });

  test("optionalSkills is empty", () => {
    expect(migratorPackage.optionalSkills).toEqual([]);
  });
});
