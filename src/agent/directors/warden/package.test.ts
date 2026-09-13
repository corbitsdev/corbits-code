import { describe, expect, test } from "bun:test";
import { wardenPackage } from "./package.js";

describe("wardenPackage", () => {
  test("id matches directory", () => {
    expect(wardenPackage.id).toBe("warden");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(wardenPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(wardenPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(wardenPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt identity is Warden / WardenDirector", () => {
    const p = wardenPackage.systemPrompt;
    expect(p).toMatch(/WardenDirector \(Warden\)/);
    expect(p).toMatch(/trust lane only/i);
  });

  test("systemPrompt trigger is written trust paths only", () => {
    const p = wardenPackage.systemPrompt;
    expect(p).toMatch(/TRIGGER/i);
    expect(p).toMatch(/permission/);
    expect(p).toMatch(/provider-auth/);
    expect(p).toMatch(/plugin-loader/);
    expect(p).toMatch(/Anything else is out of lane/);
    expect(p).toMatch(/Do not expand into general code review/);
  });

  test("systemPrompt findings lens covers the trust surface", () => {
    const p = wardenPackage.systemPrompt;
    expect(p).toMatch(/Findings lens/i);
    expect(p).toMatch(/grant-matching holes/i);
    expect(p).toMatch(/secret-guard bypass/i);
    expect(p).toMatch(/arktype boundary skips/i);
    expect(p).toMatch(/shell-policy peel gaps/i);
    expect(p).toMatch(/plugin trust/i);
    expect(p).toMatch(/blocking, should-fix, or file-for-later/i);
  });

  test("systemPrompt is evidence-based findings, never-fix", () => {
    const p = wardenPackage.systemPrompt;
    expect(p).toMatch(/evidence/);
    expect(p).toMatch(/never fix/i);
    expect(p).toMatch(/Do not ship fixes/);
    expect(p).toMatch(/permanent tests/i);
    expect(p).toContain("testsmith/builder");
    expect(p).toContain("route to builder");
  });

  test("systemPrompt is not a second critic or greybeard", () => {
    const p = wardenPackage.systemPrompt;
    expect(p).toMatch(/Do not become critic/);
    expect(p).toMatch(/greybeard/);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = wardenPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are not mounted/i);
    expect(p).not.toMatch(/via run_shell/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(wardenPackage.spawn.maySpawn).toBe(false);
  });

  test("tier is leaf", () => {
    expect(wardenPackage.tier).toBe("leaf");
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = wardenPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(wardenPackage.modelRole).toBe("review");
  });

  test("optionalSkills order is style, philosophy, native-integration, idiot-proof", () => {
    expect(wardenPackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-integration",
      "idiot-proof",
    ]);
  });

  test("primaryIntent and outOfLane match warden lane", () => {
    expect(wardenPackage.primaryIntent).toBe(
      "Trust review of permission, provider-auth, and plugin-loader diffs; never fix product code",
    );
    expect(wardenPackage.outOfLane).toContain("implementing fixes");
    expect(wardenPackage.outOfLane).toContain(
      "general code review outside trust paths",
    );
    expect(wardenPackage.outOfLane).toContain(
      "architecture judgment without trust evidence",
    );
    expect(wardenPackage.outOfLane).toContain("feature design");
  });
});
