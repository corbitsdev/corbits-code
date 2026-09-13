import { describe, expect, test } from "bun:test";
import { migratorPackage } from "./package.js";

describe("migratorPackage", () => {
  test("id matches directory / registry id", () => {
    expect(migratorPackage.id).toBe("migrator");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(migratorPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(migratorPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt identity is the reversible-migration leaf", () => {
    const p = migratorPackage.systemPrompt;
    expect(p).toContain("You are Migrator");
    expect(p).toMatch(/reversible-migration leaf/);
    expect(p).toContain("PRIMARY INTENT");
  });

  test("systemPrompt owns only settings/config/session-state data changes", () => {
    const p = migratorPackage.systemPrompt;
    expect(p).toMatch(/settings-schema/);
    expect(p).toMatch(/config-key/);
    expect(p).toMatch(/run\.json/);
    expect(p).toMatch(/context-store-layout/);
    expect(p).toMatch(/never bulk renames, never features/);
  });

  test("systemPrompt requires the three migration artifacts", () => {
    const p = migratorPackage.systemPrompt;
    expect(p).toMatch(/dry-run output/);
    expect(p).toMatch(/forward migration path/);
    expect(p).toMatch(/rollback path/);
    expect(p).toMatch(/in-flight sessions/);
  });

  test("systemPrompt verifies rollback by execution and stops when irreversible", () => {
    const p = migratorPackage.systemPrompt;
    expect(p).toMatch(/scratch copy/);
    expect(p).toMatch(/not by inspection/);
    expect(p).toMatch(/say so plainly and stop/);
    expect(p).toMatch(/do not ship it/);
  });

  test("systemPrompt states the report shape", () => {
    const p = migratorPackage.systemPrompt;
    expect(p).toMatch(
      /Report: dry-run output, forward path, rollback path, in-flight impact/,
    );
  });

  test("tools.allow is exactly read_file/grep/lsp/run_shell in order", () => {
    expect(migratorPackage.tools?.allow).toEqual([
      "read_file",
      "grep",
      "lsp",
      "run_shell",
    ]);
  });

  test("tools.allow carries no fleet verbs and no path writes", () => {
    const allow = migratorPackage.tools?.allow ?? [];
    for (const verb of [
      "spawn_agent",
      "send_input",
      "list_agents",
      "search_agents",
      "wait_agents",
    ] as const) {
      expect(allow).not.toContain(verb);
    }
    for (const tool of ["write_file", "edit_file", "delete_file"] as const) {
      expect(allow).not.toContain(tool);
    }
  });

  test("spawn.maySpawn is false with no allowlist (leaf)", () => {
    expect(migratorPackage.spawn.maySpawn).toBe(false);
    expect(migratorPackage.spawn.allowlist).toBeUndefined();
    expect(migratorPackage.tier).toBe("leaf");
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
